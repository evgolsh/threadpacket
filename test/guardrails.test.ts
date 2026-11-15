import { describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { ORIGIN, PNG, token } from "./helpers";

/**
 * The hosted service's limits for running on Cloudflare's free allowances (src/env.ts): bytes per team and for the
 * whole service, teams per address per day, assistant registrations per hour, a per-person request limit, and a
 * switch that pauses sign-up.
 */
const ctl = { ...env, THREADPACKET_MODE: "control" };
const uid = () => crypto.randomUUID().slice(0, 6);
const ip = () => `198.18.0.${Math.floor(Math.random() * 250) + 1}-${uid()}`;
const MiB = 1024 * 1024;
const fetchAs = (e: typeof env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, { redirect: "manual", ...init }), e, createExecutionContext());
const form = (fields: Record<string, string>, from = ip()): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": from },
  body: new URLSearchParams(fields),
});

async function seedTeam(team: string, ...handles: string[]) {
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO tenants (slug, name, created_at, members_cap) VALUES (?, ?, ?, 10)").bind(team, team, at),
    ...handles.map((h) => env.DB.prepare("INSERT OR IGNORE INTO members (handle, code_salt, code_hash, created_at) VALUES (?, 's', 'h', ?)").bind(`${team}/${h}`, at)),
  ]);
}
/** A stored file of `size` bytes as the database sees it; no bytes are written. */
async function seedFile(owner: string, size: number, packet?: { expiresAt: string }): Promise<string> {
  const id = `at_seed${uid()}${uid()}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO attachments (id, owner, filename, mime_type, size, sha256, state, blob_key, source, created_at, ready_at) VALUES (?, ?, 'big.pdf', 'application/pdf', ?, 'x', 'ready', ?, 'upload', ?, ?)",
  )
    .bind(id, owner, size, `att/${owner}/${id}`, at, at)
    .run();
  if (packet) {
    const pk = `pk_seed${uid()}${uid()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO packets (id, owner, recipient, title, brief, created_at, expires_at, idempotency_key, request_hash) VALUES (?, ?, ?, 'files', 'b', ?, ?, ?, 'h')").bind(pk, owner, owner, at, packet.expiresAt, pk),
      env.DB.prepare("INSERT INTO packet_attachments (packet_id, attachment_id, position) VALUES (?, ?, 0)").bind(pk, id),
    ]);
  }
  return id;
}
async function upload(subject: string, bytes = PNG) {
  const bearer = await token(subject);
  const created = await fetchAs(ctl, "/v1/uploads", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ filename: "photo.png", mime_type: "image/png" }),
  });
  if (created.status !== 201) return { step: "create", status: created.status, body: (await created.json()) as { error?: string; message?: string } };
  const { attachment_id, upload_url } = (await created.json()) as { attachment_id: string; upload_url: string };
  const put = await fetchAs(ctl, upload_url, { method: "PUT", headers: { authorization: `Bearer ${bearer}`, "content-type": "image/png" }, body: bytes });
  return { step: "put", status: put.status, attachment_id, body: (await put.json()) as { error?: string; message?: string } };
}
const text = (b: { error?: string; message?: string }) => JSON.stringify(b);

describe("storage on the hosted service", () => {
  it("a team may keep 256 MiB of live files; another team is not affected", async () => {
    const team = `fam-${uid()}`;
    await seedTeam(team, "joe", "anna");
    await seedFile(`${team}/anna`, 256 * MiB);
    const full = await upload(`${team}/joe`);
    expect(full).toMatchObject({ step: "create", status: 429 });
    expect(text(full.body)).toContain("256 MiB a team may keep");

    const other = `fam-${uid()}`;
    await seedTeam(other, "kim");
    expect(await upload(`${other}/kim`)).toMatchObject({ step: "put", status: 200 });
  });

  it("refuses the bytes that would pass the cap, and marks that upload failed", async () => {
    const team = `fam-${uid()}`;
    await seedTeam(team, "joe");
    await seedFile(`${team}/joe`, 256 * MiB - 10);
    const r = await upload(`${team}/joe`);
    expect(r).toMatchObject({ step: "put", status: 429 });
    expect(text(r.body)).toContain("this file needs 1 MiB");
    expect(await env.DB.prepare("SELECT state, fail_reason FROM attachments WHERE id = ?").bind(r.attachment_id).first()).toEqual({ state: "failed", fail_reason: "storage full" });
  });

  it("files of an expired packet no longer count, though they wait a week for cleanup", async () => {
    const team = `fam-${uid()}`;
    await seedTeam(team, "joe");
    await seedFile(`${team}/joe`, 256 * MiB, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await upload(`${team}/joe`)).toMatchObject({ step: "put", status: 200 });
    await seedFile(`${team}/joe`, 256 * MiB, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await upload(`${team}/joe`)).toMatchObject({ step: "create", status: 429 });
  });

  it("above 8 GiB stored in all, nobody can upload, counting files that wait for cleanup", async () => {
    const team = `fam-${uid()}`;
    await seedTeam(team, "joe");
    const big = await seedFile(`other-${uid()}/x`, 8 * 1024 * MiB, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    try {
      const r = await upload(`${team}/joe`);
      expect(r).toMatchObject({ step: "create", status: 429 });
      expect(text(r.body)).toContain("file storage is full");
    } finally {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM packet_attachments WHERE attachment_id = ?").bind(big),
        env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(big),
      ]);
    }
  });

  it("a private install has no byte caps", async () => {
    await seedFile("tim", 300 * MiB);
    const bearer = await token("tim");
    const created = await fetchAs(env, "/v1/uploads", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "photo.png", mime_type: "image/png" }),
    });
    expect(created.status).toBe(201);
  });
});

describe("sign-up limits", () => {
  it("one address creates at most 5 teams a day; failed tries do not count", async () => {
    const from = ip();
    const taken = `taken-${uid()}`;
    await seedTeam(taken, "someone");
    expect((await fetchAs(ctl, "/join", form({ team: taken, handle: "joe" }, from))).status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await fetchAs(ctl, "/join", form({ team: `day-${uid()}`, handle: "joe" }, from))).status).toBe(200);
    const sixth = await fetchAs(ctl, "/join", form({ team: `day-${uid()}`, handle: "joe" }, from));
    expect(sixth.status).toBe(429);
    expect(await sixth.text()).toContain("created 5 teams today");
    expect((await fetchAs(ctl, "/join", form({ team: `day-${uid()}`, handle: "joe" }))).status).toBe(200);
  });

  it("THREADPACKET_SIGNUPS=closed pauses sign-up on both forms; signing in is unchanged", async () => {
    const paused = { ...ctl, THREADPACKET_SIGNUPS: "closed" };
    const page = await (await fetchAs(paused, "/join")).text();
    expect(page).toContain("Sign-up is paused.");
    expect(page).not.toContain('action="/join"');
    expect(page).not.toMatch(/<script\b/);
    const team = `paused-${uid()}`;
    const post = await fetchAs(paused, "/join", form({ team, handle: "joe" }));
    expect(post.status).toBe(503);
    expect(await env.DB.prepare("SELECT 1 AS ok FROM tenants WHERE slug = ?").bind(team).first()).toBeNull();

    const reg = await fetchAs(paused, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost:4420/cb"] }) });
    const { client_id } = (await reg.json()) as { client_id: string };
    const qs = new URLSearchParams({ client_id, redirect_uri: "http://localhost:4420/cb", response_type: "code", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" });
    const signIn = await fetchAs(paused, `/authorize?${qs}`);
    expect(signIn.headers.get("content-security-policy")).not.toContain("script-src");
    const html = await signIn.text();
    expect(html).toContain('action="/authorize"');
    expect(html).not.toContain('id="new-team"');
    const create = await fetchAs(paused, "/authorize", form({ ...Object.fromEntries(qs), action: "create_team", team, handle: "joe" }));
    expect(create.status).toBe(503);
    expect(await create.text()).toContain("Sign-up is paused");
  });
});

describe("assistant registrations", () => {
  it("the hosted service registers at most 1,000 assistants an hour", async () => {
    const at = new Date().toISOString();
    const ids = Array.from({ length: 1000 }, (_, i) => `client_flood${uid()}${i}`);
    await env.DB.batch(ids.map((id) => env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, '[]', 'x', ?)").bind(id, at)));
    const register = (e: typeof env) =>
      fetchAs(e, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost:4430/cb"] }) });
    try {
      const refused = await register(ctl);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("600");
      expect(await refused.json()).toMatchObject({ error: "temporarily_unavailable" });
      expect((await register(env)).status).toBe(201);
    } finally {
      await env.DB.prepare("DELETE FROM oauth_clients WHERE client_id LIKE 'client_flood%'").run();
    }
  });
});

describe("the per-person limit", () => {
  it("asks Cloudflare's rate limiter with the signed-in person, and answers 429 when it says no", async () => {
    const asked: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (asked.push(key), { success: key !== "fam-busy/joe" }) };
    const limited = { ...ctl, MEMBER_LIMITER: limiter as unknown as RateLimit };
    const inbox = async (subject: string) =>
      fetchAs(limited, "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token(subject)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "threadpacket_inbox", arguments: {} } }),
      });
    await seedTeam("fam-busy", "joe", "anna");
    const busy = await inbox("fam-busy/joe");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("60");
    expect(await busy.json()).toMatchObject({ error: "rate_limited" });
    expect((await inbox("fam-busy/anna")).status).toBe(200);
    expect(asked).toEqual(["fam-busy/joe", "fam-busy/anna"]);
  });
});
