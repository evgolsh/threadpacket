import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { upsertMember } from "../src/auth/builtin";
import { runCleanup } from "../src/cleanup";
import { controlCenter, publicStats } from "../src/console/stats";
import type { Env } from "../src/env";
import { pruneRecords } from "../src/store/events";
import { sourceOf } from "../src/store/pageviews";
import { rollUpDailyTotals } from "../src/store/totals";
import { ORIGIN } from "./helpers";

/** Page views, outside counts, the sign-up funnel and daily totals on the control center. */
const ctl = { ...env, THREADPACKET_MODE: "control" } as Env;
const uid = () => crypto.randomUUID().slice(0, 6);
const BROWSER = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15" };

async function visit(e: Env, path: string, headers: Record<string, string> = {}): Promise<number> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { ...BROWSER, ...headers }, redirect: "manual" }), e, ctx);
  await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return res.status;
}
const viewsFrom = async (source: string) => (await env.DB.prepare("SELECT path, n FROM page_views WHERE source = ? ORDER BY path").bind(source).all()).results;

const post = (path: string, fields: Record<string, string>, cookie = ""): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250) + 1}`, cookie },
    body: new URLSearchParams(fields),
  });
const fetchAs = (req: Request) => worker.fetch(req, ctl, createExecutionContext());

async function operator() {
  const op = { handle: `op-${uid()}`, code: `operator-code-${uid()}` };
  await upsertMember(env.DB, op.handle, op.code);
  await env.DB.prepare("INSERT OR IGNORE INTO admin_members (handle) VALUES (?)").bind(op.handle).run();
  const res = await fetchAs(post("/login", { handle: op.handle, access_code: op.code }));
  expect(res.status).toBe(303);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = async (path: string) => (await fetchAs(new Request(`${ORIGIN}${path}`, { headers: { cookie }, redirect: "manual" }))).text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page("/console/tenants"))![1]!;
  return { handle: op.handle, page, submit: (path: string, fields: Record<string, string>) => fetchAs(post(path, { csrf, ...fields }, cookie)) };
}

const addTeam = (slug: string, createdAt: string, internal = 0) =>
  env.DB.prepare("INSERT INTO tenants (slug, name, created_at, internal) VALUES (?, ?, ?, ?)").bind(slug, slug, createdAt, internal).run();
const addEvent = (ts: string, kind: string, name: string, subject: string, outcome = "ok") =>
  env.DB.prepare("INSERT INTO events (ts, kind, name, subject, outcome) VALUES (?, ?, ?, ?, ?)").bind(ts, kind, name, subject, outcome).run();

describe("page views", () => {
  it("counts a browser's page load per day, page and source, and stores nothing that identifies the visitor", async () => {
    const tag = `t${uid()}`;
    expect(await visit(ctl, `/?ref=${tag}`)).toBe(200);
    expect(await visit(ctl, `/join?ref=${tag}`)).toBe(200);
    expect(await visit(ctl, `/join?ref=${tag}`)).toBe(200);
    expect(await viewsFrom(tag)).toEqual([
      { path: "/", n: 1 },
      { path: "/join", n: 2 },
    ]);
    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('page_views') ORDER BY cid").all<{ name: string }>()).results.map((r) => r.name);
    expect(columns).toEqual(["day", "path", "source", "country", "n"]);
  });

  it("does not count scripts, crawlers, prefetches, other pages, errors or a private install", async () => {
    const tag = `t${uid()}`;
    await visit(ctl, `/?ref=${tag}`, { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
    await visit(ctl, `/?ref=${tag}`, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    await visit(ctl, `/?ref=${tag}`, { "sec-purpose": "prefetch" });
    await visit(ctl, `/llms.txt?ref=${tag}`);
    await visit(ctl, `/packets?ref=${tag}`);
    expect(await visit(ctl, `/no-such-page?ref=${tag}`)).toBe(404);
    expect(await visit(env as Env, `/connect?ref=${tag}`)).toBe(200);
    expect(await viewsFrom(tag)).toEqual([]);
  });

  it("names the source by the link's tag, else the referring site, with this site as self", () => {
    const at = (path: string) => new URL(`https://threadpacket.test${path}`);
    expect(sourceOf(at("/"), "https://news.ycombinator.com/item?id=1", "threadpacket.test")).toBe("news.ycombinator.com");
    expect(sourceOf(at("/"), "https://www.reddit.com/r/ClaudeAI/", "threadpacket.test")).toBe("reddit.com");
    expect(sourceOf(at("/join"), "https://threadpacket.test/", "threadpacket.test")).toBe("self");
    expect(sourceOf(at("/?ref=HN"), "https://t.co/", "threadpacket.test")).toBe("hn");
    expect(sourceOf(at("/?utm_source=newsletter"), null, "threadpacket.test")).toBe("newsletter");
    expect(sourceOf(at("/?ref=%3Cscript%3E"), "https://github.com/x", "threadpacket.test")).toBe("github.com");
    expect(sourceOf(at("/"), "not a url", "threadpacket.test")).toBe("");
    expect(sourceOf(at("/"), null, "threadpacket.test")).toBe("");
  });

  it("cleanup removes page views older than 400 days", async () => {
    await env.DB.prepare("INSERT INTO page_views (day, path, source, country, n) VALUES ('2020-01-01', '/', 'old', '', 5)").run();
    expect((await pruneRecords(env.DB)).page_views).toBeGreaterThanOrEqual(1);
    expect(await viewsFrom("old")).toEqual([]);
  });
});

describe("outside counts", () => {
  it("an internal team is listed but left out of the counts and /stats; the operator marks it and counts it again", async () => {
    const team = `own-${uid()}`;
    const now = new Date().toISOString();
    await addTeam(team, now);
    await upsertMember(env.DB, `${team}/tim`, "synthetic-member-code");
    await addEvent(now, "tool", "threadpacket_read", `${team}/tim`);
    await addEvent(now, "tool", "threadpacket_send", `${team}/tim`);
    const op = await operator();
    // The operator's own account, without a team, is never counted.
    await addEvent(now, "tool", "threadpacket_read", op.handle);

    const before = await controlCenter(env.DB);
    const statsBefore = await publicStats(env.DB);
    const res = await op.submit(`/console/tenants/${team}/internal`, { internal: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/console/tenants?did=internal&team=${team}`);
    const after = await controlCenter(env.DB);
    expect(before.users.d7 - after.users.d7).toBe(1);
    expect(before.activity.sends_7d - after.activity.sends_7d).toBe(1);
    expect(before.totals.tenants - after.totals.tenants).toBe(1);
    expect(before.totals.members - after.totals.members).toBe(1);
    expect(after.totals.internal - before.totals.internal).toBe(1);
    expect(after.tenants.find((t) => t.slug === team)?.internal).toBe(true);
    expect(Number(statsBefore.users_7d) - Number((await publicStats(env.DB)).users_7d)).toBe(1);

    const page = await op.page(`/console/tenants?did=internal&team=${team}`);
    expect(page).toContain(`Team ${team} is internal`);
    expect(page).toContain(`<strong>${team}</strong> <span class="small muted">· internal</span>`);
    expect(page).toContain(`action="/console/tenants/${team}/internal"`);
    expect(page).toContain("Count as outside");
    expect(await op.page("/console/ops")).toContain("marked internal: team <strong>" + team + "</strong>");

    expect((await op.submit(`/console/tenants/${team}/internal`, { internal: "0" })).status).toBe(303);
    expect((await controlCenter(env.DB)).users.d7).toBe(before.users.d7);
    expect((await op.submit(`/console/tenants/no-such-${uid()}/internal`, { internal: "1" })).status).toBe(404);
  });

  it("a team's admin cannot mark teams internal", async () => {
    const team = `adm-${uid()}`;
    await addTeam(team, new Date().toISOString());
    const code = `admin-code-${uid()}`;
    await upsertMember(env.DB, `${team}/ann`, code);
    await env.DB.prepare("INSERT INTO admin_members (handle) VALUES (?)").bind(`${team}/ann`).run();
    const login = await fetchAs(post("/login", { handle: "ann", access_code: code }));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const overview = await (await fetchAs(new Request(`${ORIGIN}/console/overview`, { headers: { cookie } }))).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(overview)![1]!;
    const res = await fetchAs(post(`/console/tenants/${team}/internal`, { csrf, internal: "1" }, cookie));
    expect(res.headers.get("location")).toBe("/console/overview");
    expect(await env.DB.prepare("SELECT internal FROM tenants WHERE slug = ?").bind(team).first()).toEqual({ internal: 0 });
  });
});

describe("the funnel and the daily totals", () => {
  // A Wednesday far from the other tests' data, so the windows hold only these rows.
  const now = Date.parse("2031-03-12T12:00:00Z");
  const s = uid();
  const [t1, t2, t3, old] = [`f1-${s}`, `f2-${s}`, `fi-${s}`, `fo-${s}`];

  it("follows the outside teams created in 28 days from the homepage to a packet read", async () => {
    for (const [day, path, n] of [["2031-03-10", "/", 40], ["2031-03-10", "/join", 10], ["2031-03-11", "/connect", 7], ["2031-01-01", "/", 999]] as const) {
      await env.DB.prepare("INSERT INTO page_views (day, path, source, country, n) VALUES (?, ?, 'news.ycombinator.com', 'US', ?)").bind(day, path, n).run();
    }
    await env.DB.prepare("INSERT INTO page_views (day, path, source, country, n) VALUES ('2031-03-11', '/join', 'self', 'IL', 4)").run();
    await addTeam(t1, "2031-03-05T09:00:00.000Z");
    await addTeam(t2, "2031-03-06T09:00:00.000Z");
    await addTeam(t3, "2031-03-07T09:00:00.000Z", 1);
    await addTeam(old, "2031-01-01T09:00:00.000Z");
    await addEvent("2031-03-05T09:00:00.000Z", "console", "join", `${t1}/tim`);
    await addEvent("2031-03-06T09:00:00.000Z", "console", "join", `${t2}/ann`);
    await addEvent("2031-03-07T09:00:00.000Z", "console", "join", `${t3}/joe`);
    await addEvent("2031-03-05T10:00:00.000Z", "token", "authorization_code", `${t1}/tim`);
    await addEvent("2031-03-06T10:00:00.000Z", "initialize", "Claude", `${t2}/ann`);
    await addEvent("2031-03-08T10:00:00.000Z", "tool", "threadpacket_send", `${t1}/tim`);
    await addEvent("2031-03-08T11:00:00.000Z", "tool", "threadpacket_send", `${t2}/ann`, "not_found");
    await addEvent("2031-03-09T10:00:00.000Z", "tool", "threadpacket_read", `${t1}/tim`);
    await addEvent("2031-03-10T10:00:00.000Z", "tool", "threadpacket_read", `${t1}/bob`);
    for (const kind of ["token", "tool"]) await addEvent("2031-03-08T10:00:00.000Z", kind, kind === "tool" ? "threadpacket_send" : "authorization_code", `${t3}/joe`);
    await addEvent("2031-03-09T10:00:00.000Z", "tool", "threadpacket_read", `${t3}/joe`);

    const c = await controlCenter(env.DB, now);
    expect(c.funnel).toEqual({ homeViews: 40, joinViews: 14, teams: 2, connected: 2, sent: 1, read: 1 });
    expect(c.web.views28d).toBe(61);
    expect(c.web.views7d).toBe(61);
    expect(c.web.pages).toEqual([
      { path: "/", d7: 40, d28: 40 },
      { path: "/join", d7: 14, d28: 14 },
      { path: "/connect", d7: 7, d28: 7 },
    ]);
    expect(c.web.sources).toEqual([{ source: "news.ycombinator.com", n: 57 }]);
    expect(c.web.countries).toEqual([
      { country: "US", n: 57 },
      { country: "IL", n: 4 },
    ]);
    expect(c.web.days.at(-2)).toEqual({ date: "2031-03-11", views: 11 });
  });

  it("follows invitations of outside teams to a packet read in the browser, and counts readers with no assistant", async () => {
    const [ti, tin] = [`iv-${s}`, `ivi-${s}`];
    await addTeam(ti, "2031-03-01T09:00:00.000Z");
    await addTeam(tin, "2031-03-01T09:00:00.000Z", 1);
    for (const who of ["ann", "bob", "cat"]) await addEvent("2031-03-02T09:00:00.000Z", "console", "invite", `${ti}/joe`, who === "cat" ? "reinvite" : "ok");
    await addEvent("2031-03-02T09:00:00.000Z", "console", "invite", `${tin}/joe`);
    // ann opens her link and reads in the browser, then connects Claude; bob opens his link and reads in the browser only.
    await addEvent("2031-03-03T09:00:00.000Z", "console", "invite_open", `${ti}/ann`);
    await addEvent("2031-03-03T09:01:00.000Z", "packets", "open", `${ti}/ann`);
    await addEvent("2031-03-04T09:00:00.000Z", "initialize", "Claude", `${ti}/ann`);
    await addEvent("2031-03-03T10:00:00.000Z", "console", "invite_open", `${ti}/bob`);
    await addEvent("2031-03-03T10:01:00.000Z", "packets", "open", `${ti}/bob`);
    await addEvent("2031-03-03T10:02:00.000Z", "packets", "open", `${ti}/bob`);
    // An internal team's invitee is not counted.
    await addEvent("2031-03-03T11:00:00.000Z", "console", "invite_open", `${tin}/dee`);
    await addEvent("2031-03-03T11:01:00.000Z", "packets", "open", `${tin}/dee`);

    expect((await controlCenter(env.DB, now)).invites).toEqual({ made: 3, opened: 2, readInBrowser: 2, connected: 1, browserOnly: 1 });
  });

  it("keeps daily totals of outside activity, recomputing the last 3 days and filling missing ones", async () => {
    expect(await rollUpDailyTotals(env.DB, now)).toBe(30 * 3 + 24);
    const total = async (day: string, metric: string) => (await env.DB.prepare("SELECT n FROM daily_totals WHERE day = ? AND metric = ?").bind(day, metric).first<{ n: number }>())?.n ?? null;
    expect(await total("2031-03-05", "joins")).toBe(1);
    expect(await total("2031-03-07", "joins")).toBe(0);
    expect(await total("2031-03-08", "sends")).toBe(1);
    expect(await total("2031-03-09", "reads")).toBe(1);
    expect(await total("2031-03-09", "users_7d")).toBe(1);
    expect(await total("2031-03-12", "users_7d")).toBe(2);
    expect(await total("2031-02-11", "users_7d")).toBeNull();

    expect(await rollUpDailyTotals(env.DB, now)).toBe(3 * 4);
    await env.DB.prepare("DELETE FROM daily_totals WHERE day = '2031-03-01' AND metric = 'sends'").run();
    expect(await rollUpDailyTotals(env.DB, now)).toBe(3 * 4 + 1);

    const weeks = (await controlCenter(env.DB, now)).weeks;
    expect(weeks.at(-1)).toEqual({ week: "2031-03-10", views: 61, joins: 0, sends: 0, reads: 1, users: 2 });
    expect(weeks.at(-2)).toEqual({ week: "2031-03-03", views: 0, joins: 2, sends: 1, reads: 1, users: 1 });
  });

  it("the Tenants page shows the funnel, the sources and the weeks", async () => {
    const op = await operator();
    const page = await op.page("/console/tenants");
    for (const text of ["Sign-up funnel, 28 days", "Invitations, 28 days", "Where visits came from, 28 days", "page views, 28 days", "By week", "Mark internal"]) expect(page).toContain(text);
  });

  it("the hourly cleanup writes today's totals on the control center only", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM daily_totals WHERE day = ?").bind(today).run();
    await runCleanup(env as Env, "console");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_totals WHERE day = ?").bind(today).first()).toEqual({ n: 0 });
    await runCleanup(ctl, "console");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_totals WHERE day = ?").bind(today).first()).toEqual({ n: 4 });
  });
});

describe("the privacy page", () => {
  it("lists page visits on the hosted service only", async () => {
    const hosted = await (await worker.fetch(new Request(`${ORIGIN}/privacy`), ctl, createExecutionContext())).text();
    expect(hosted).toContain("Page visits");
    expect(hosted).toContain("deleted after 400 days");
    const own = await (await worker.fetch(new Request(`${ORIGIN}/privacy`), env as Env, createExecutionContext())).text();
    expect(own).not.toContain("Page visits");
  });
});
