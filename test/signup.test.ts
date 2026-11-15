import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { NEW_HANDLE_PATTERN, TEAM_NAME_PATTERN } from "../src/auth/builtin";
import { base64url } from "../src/domain/ids";
import { TEAM_CHECK_SCRIPT } from "../src/http/team-check";
import { createTeam } from "../src/domain/teams";
import { configFrom } from "../src/env";
import { ORIGIN, call, errorText, expectOk, token } from "./helpers";

/**
 * Sign-up on the hosted service: a new username needs 3 characters, and both "Create a team" forms (/join and
 * the sign-in page an assistant opens) check the team name live, through /join/check.
 */
const ctl = { ...env, THREADPACKET_MODE: "control" };
const uid = () => crypto.randomUUID().slice(0, 6);
const ip = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}-${uid()}`;
const fetchAs = (e: typeof env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), e, createExecutionContext());
const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": ip() },
  body: new URLSearchParams(fields),
});
const check = async (team: string, handle = "") => {
  const res = await fetchAs(ctl, `/join/check?${new URLSearchParams({ team, handle })}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as { name: string; state: string; message: string };
};
async function seedTeam(team: string, admin: string) {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO tenants (slug, name, created_at, members_cap) VALUES (?, ?, ?, 10)").bind(team, team, at),
    env.DB.prepare("INSERT OR IGNORE INTO members (handle, code_salt, code_hash, created_at) VALUES (?, 's', 'h', ?)").bind(`${team}/${admin}`, at),
    env.DB.prepare("INSERT OR IGNORE INTO admin_members (handle) VALUES (?)").bind(`${team}/${admin}`),
  ]);
}
async function oauthParams() {
  const reg = await fetchAs(ctl, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost:4410/cb"] }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`v-${crypto.randomUUID()}`))));
  return { client_id, redirect_uri: "http://localhost:4410/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "threadpacket" };
}

describe("the live team-name check", () => {
  it("says a free name is available and a taken one is taken", async () => {
    const team = `smiths-${uid()}`;
    expect(await check(team)).toEqual({ name: team, state: "ok", message: `${team} is available` });
    expect(await check(` ${team.toUpperCase()} `)).toMatchObject({ name: team, state: "ok" });
    await seedTeam(team, "joe");
    expect(await check(team)).toMatchObject({ name: team, state: "taken", message: expect.stringContaining(`${team} is taken`) });
  });

  it("refuses reserved and malformed names before anyone submits", async () => {
    expect(await check("admin")).toMatchObject({ state: "bad", message: "admin is reserved. Choose another name." });
    expect(await check("ab")).toMatchObject({ state: "bad", message: expect.stringContaining("3 to 32") });
    expect(await check("-smiths")).toMatchObject({ state: "bad" });
    expect(await check("www")).toMatchObject({ state: "bad", message: "www is reserved. Choose another name." });
    expect(await check("", "www")).toEqual({ name: "www-team", state: "ok", message: "Your team will be www-team" });
  });

  it("with no team typed, names the team the username gives, or says a number gets added", async () => {
    expect(await check("", "jo")).toEqual({ name: "", state: "", message: "Leave it empty to use your username." });
    const handle = `lee-${uid()}`;
    expect(await check("", handle)).toEqual({ name: handle, state: "ok", message: `Your team will be ${handle}` });
    await seedTeam(handle, "someone");
    expect(await check("", handle)).toMatchObject({ name: handle, state: "", message: expect.stringContaining(`${handle}-`) });
  });

  it("is on the hosted service only", async () => {
    expect((await fetchAs(env, "/join/check?team=smiths")).status).toBe(404);
  });
});

describe("the sign-up forms", () => {
  it("/join runs the check with its own nonce, may fetch only this site, and asks for 3 characters", async () => {
    const res = await fetchAs(ctl, "/join");
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toContain("data-team-check");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('fetch("/join/check?"');
    expect(html).toMatch(/id="handle" name="handle"[^>]*minlength="3"/);
    expect(html).toContain('data-avail="team"');
  });

  it("/join refuses a username shorter than 3 characters and keeps what was typed", async () => {
    const team = `kim-${uid()}`;
    const res = await fetchAs(ctl, "/join", form({ team, handle: "jo" }));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("3 to 63");
    expect(html).toContain(`value="${team}"`);
    expect(html).toContain("data-team-check");
    expect(await env.DB.prepare("SELECT 1 AS ok FROM tenants WHERE slug = ?").bind(team).first()).toBeNull();
    expect((await fetchAs(ctl, "/join", form({ team, handle: "joe" }))).status).toBe(200);
    expect(await env.DB.prepare("SELECT name FROM tenants WHERE slug = ?").bind(team).first()).toEqual({ name: team });
  });

  it("the sign-in page runs the check only where it offers Create a team", async () => {
    const params = await oauthParams();
    const qs = new URLSearchParams(params).toString();
    const hosted = await fetchAs(ctl, `/authorize?${qs}`);
    expect(hosted.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'; connect-src 'self'/);
    const html = await hosted.text();
    expect(html).toContain("data-team-check");
    expect(html).toMatch(/<script nonce="[A-Za-z0-9_-]+">/);

    const priv = await fetchAs(env, `/authorize?${qs}`);
    expect(priv.headers.get("content-security-policy")).not.toContain("script-src");
    expect(await priv.text()).not.toMatch(/<script\b/);
  });

  it("a space a phone keyboard adds after a word passes the fields and is trimmed on the server", async () => {
    // How a browser applies a pattern attribute: the whole value, with the v flag.
    const fits = (pattern: string, value: string) => new RegExp(`^(?:${pattern})$`, "v").test(value);
    for (const v of ["joe", "joe ", " joe", "Joe.Smith_2 "]) expect(fits(NEW_HANDLE_PATTERN, v), v).toBe(true);
    for (const v of ["jo", "jo ", "jo e", "-joe", ""]) expect(fits(NEW_HANDLE_PATTERN, v), v).toBe(false);
    for (const v of ["smiths", "smiths ", " smiths"]) expect(fits(TEAM_NAME_PATTERN, v), v).toBe(true);
    for (const v of ["sm", "smiths-", "smi ths"]) expect(fits(TEAM_NAME_PATTERN, v), v).toBe(false);

    const html = await (await fetchAs(ctl, "/join")).text();
    expect(html).toContain(`pattern="${NEW_HANDLE_PATTERN}"`);
    expect(html).toContain(`pattern="${TEAM_NAME_PATTERN}"`);
    const team = `smiths-${uid()}`;
    const res = await fetchAs(ctl, "/join", form({ team: `${team} `, handle: "joe " }));
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 AS ok FROM members WHERE handle = ?").bind(`${team}/joe`).first()).toEqual({ ok: 1 });
  });

  it("the live check says team and all are reserved, and drops a trailing space when the field is left", () => {
    const page = (handle: string, team = "smiths") => {
      const on: Record<string, Record<string, () => void>> = {};
      const field = (name: string, value: string) => ({ value, addEventListener: (ev: string, fn: () => void) => ((on[name] ??= {})[ev] = fn) });
      const els: Record<string, any> = { handle: field("handle", handle), team: field("team", team), handleOut: { textContent: "", dataset: {} }, teamOut: { textContent: "", dataset: {} } };
      const key: Record<string, string> = { '[name="handle"]': "handle", '[name="team"]': "team", '[data-avail="handle"]': "handleOut", '[data-avail="team"]': "teamOut" };
      const form = { querySelector: (sel: string) => els[key[sel]!] };
      const fetchStub = () => new Promise(() => {});
      new Function("document", "fetch", "setTimeout", "clearTimeout", TEAM_CHECK_SCRIPT)({ querySelectorAll: () => [form] }, fetchStub, () => 0, () => {});
      return { els, on };
    };
    for (const h of ["team", "all", "Team "]) {
      const { els } = page(h);
      expect(els.handleOut.textContent, h).toBe("team and all are reserved.");
      expect(els.handleOut.dataset.state).toBe("bad");
    }
    expect(page("joe").els.handleOut.textContent).toBe("");

    const { els, on } = page("joe ", "smiths ");
    on.handle!.change!();
    on.team!.change!();
    expect([els.handle.value, els.team.value]).toEqual(["joe", "smiths"]);
  });

  it("Create a team on the sign-in page refuses a 2-character username", async () => {
    const params = await oauthParams();
    const team = `kim-${uid()}`;
    const res = await fetchAs(ctl, "/authorize", form({ ...params, action: "create_team", team, handle: "jo" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("3 to 63");
    expect(await env.DB.prepare("SELECT 1 AS ok FROM tenants WHERE slug = ?").bind(team).first()).toBeNull();
  });
});

describe("invitations", () => {
  it("a new person needs 3 characters; someone already on the team with a shorter name can be invited again", async () => {
    const team = `fam-${uid()}`;
    await seedTeam(team, "joe");
    const joe = await token(`${team}/joe`);
    expect(errorText(await call(joe, "threadpacket_invite", { username: "al" }))).toContain("3 to 63");
    await env.DB.prepare("INSERT INTO members (handle, code_salt, code_hash, created_at) VALUES (?, 's', 'h', ?)").bind(`${team}/al`, new Date().toISOString()).run();
    expect(expectOk(await call(joe, "threadpacket_invite", { username: "al" }))).toMatchObject({ username: "al" });
  });
});

describe("two sign-ups for one team name", () => {
  it("in the same millisecond, the second person gets no seat in the first person's team", async () => {
    const team = `race-${uid()}`;
    const at = new Date("2026-11-15T10:00:00.123Z");
    // The first sign-up has just written the team, its member and its admin, stamped at this millisecond.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tenants (slug, name, created_at, members_cap) VALUES (?, ?, ?, 10)").bind(team, team, at.toISOString()),
      env.DB.prepare("INSERT INTO members (handle, code_salt, code_hash, created_at) VALUES (?, 's', 'h', ?)").bind(`${team}/joe`, at.toISOString()),
      env.DB.prepare("INSERT INTO admin_members (handle) VALUES (?)").bind(`${team}/joe`),
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    try {
      const second = await createTeam(env.DB, configFrom(ctl as typeof env), team, "anna", ip());
      expect(second).toMatchObject({ ok: false, status: 409 });
    } finally {
      vi.useRealTimers();
    }
    expect(await env.DB.prepare("SELECT 1 AS ok FROM members WHERE handle = ?").bind(`${team}/anna`).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS ok FROM admin_members WHERE handle = ?").bind(`${team}/anna`).first()).toBeNull();
  });
});
