import type { Config } from "../env";
import { NEW_HANDLE_RULE, codeRecord, isValidNewHandle, newAccessCode, normalizeHandle } from "../auth/builtin";
import { addOne, countSoFar, loginAllowed } from "../console/session";
import { recordEvent, revokeAccess } from "../store/events";
import { nowIso } from "./ids";
import { RESERVED_TENANTS, isValidTenant, qualify } from "./tenant";

/**
 * Creating a team on the hosted service: the team, its first member and that member's admin grant, in one
 * transaction. Used by the sign-up page (/join) and by the sign-in page an assistant opens (/authorize), so a
 * new person can start from either. The team name is optional: someone on their own gets a team named after
 * their username (with a number when that name is taken), and never has to type it, because sign-in asks only
 * for the username and access code.
 */

export const JOIN_ATTEMPTS_PURPOSE = "join";
/** The daily count of teams an address created (Config.teamsPerIpPerDay). */
const TEAMS_TODAY_PURPOSE = "join-day";
const DAY_MS = 86_400_000;

export type CreatedTeam =
  | { ok: true; team: string; handle: string; identity: string; code: string }
  | { ok: false; team: string; handle: string; error: string; status: number };

/** A team name made from a username: dots and underscores become hyphens, and a short one gets "-team". */
export function teamFromUsername(handle: string): string {
  let t = handle.replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "");
  if (t.length < 3) t = `${t}-team`;
  return isValidTenant(t) ? t : `${t.slice(0, 27).replace(/-$/, "")}-team`;
}

export async function createTeam(db: D1Database, cfg: Config, rawTeam: string, rawHandle: string, ip: string | undefined): Promise<CreatedTeam> {
  const typed = normalizeHandle(rawTeam);
  const handle = normalizeHandle(rawHandle);
  const fail = (error: string, status: number, team = typed): CreatedTeam => ({ ok: false, team, handle, error, status });
  if (!cfg.signupsOpen) return fail("Sign-up is paused on the hosted service for now. Try again later, or ask a team's admin to invite you.", 503);
  if (!(await loginAllowed(db, ip, JOIN_ATTEMPTS_PURPOSE))) return fail("Too many attempts from this address. Try again in 10 minutes.", 429);
  const perDay = cfg.teamsPerIpPerDay;
  if (perDay > 0 && (await countSoFar(db, ip, TEAMS_TODAY_PURPOSE)) >= perDay) {
    return fail(`This address has created ${perDay} teams today, the most the hosted service allows. Try again tomorrow, or ask a team's admin to invite you.`, 429);
  }
  if (!isValidNewHandle(handle)) return fail(`Username: ${NEW_HANDLE_RULE}. team and all are reserved.`, 400);
  if (typed && !isValidTenant(typed)) return fail("Team name: 3 to 32 lower-case letters, digits or hyphens, starting and ending with a letter or digit. Some names are reserved.", 400);

  // A typed name is used as it is. Without one: the username's own team, then a numbered one if that is taken.
  const base = typed || teamFromUsername(handle);
  const names = typed ? [base] : [base, ...[0, 1, 2].map(() => `${base.slice(0, 27).replace(/-$/, "")}-${100 + Math.floor(Math.random() * 900)}`)];
  for (const team of names) {
    const made = await insertTeam(db, cfg, team, handle);
    if (made) {
      if (perDay > 0) await addOne(db, ip, TEAMS_TODAY_PURPOSE, DAY_MS);
      return made;
    }
  }
  await recordEvent(db, { kind: "console", name: "join", outcome: "taken" }, { unauthenticated: true });
  return fail(`The team name ${base} is taken. Choose another, or ask that team's admin to invite you.`, 409);
}

/** What the live check under a "Create a team" form shows: free, taken, not allowed, or the name a blank field gets. */
export interface TeamNameStatus {
  name: string;
  state: "ok" | "taken" | "bad" | "";
  message: string;
}

export async function teamNameStatus(db: D1Database, rawTeam: string, rawHandle: string): Promise<TeamNameStatus> {
  const typed = normalizeHandle(rawTeam);
  const handle = normalizeHandle(rawHandle);
  const free = async (slug: string) => !(await db.prepare("SELECT 1 AS ok FROM tenants WHERE slug = ?").bind(slug).first());
  if (typed) {
    if (RESERVED_TENANTS.has(typed)) return { name: typed, state: "bad", message: `${typed} is reserved. Choose another name.` };
    if (!isValidTenant(typed)) return { name: typed, state: "bad", message: "3 to 32 letters, digits or hyphens, starting and ending with a letter or digit." };
    return (await free(typed))
      ? { name: typed, state: "ok", message: `${typed} is available` }
      : { name: typed, state: "taken", message: `${typed} is taken. Choose another, or ask that team's admin to invite you.` };
  }
  if (!isValidNewHandle(handle)) return { name: "", state: "", message: "Leave it empty to use your username." };
  const base = teamFromUsername(handle);
  return (await free(base))
    ? { name: base, state: "ok", message: `Your team will be ${base}` }
    : { name: base, state: "", message: `${base} is taken, so your team gets a number added (${base}-…). Or type a name.` };
}

/** One try at a team name. Null when the name is taken. */
async function insertTeam(db: D1Database, cfg: Config, team: string, handle: string): Promise<CreatedTeam | null> {
  const identity = qualify(team, handle);
  const code = newAccessCode();
  const { salt, hash, lookup } = await codeRecord(code);
  const at = nowIso();
  // One transaction: the tenant, its first member and the admin grant are written only if this attempt wrote the
  // tenant. The tenant row carries a token of this attempt as its name until the last statement sets the real
  // name, so a sign-up that lost the race in the same millisecond cannot add its person to the winner's team.
  // Nothing outside the transaction ever sees the token.
  const attempt = `creating:${hash}`;
  const done = await db.batch([
    db.prepare("INSERT OR IGNORE INTO tenants (slug, name, created_at, members_cap) VALUES (?, ?, ?, ?)").bind(team, attempt, at, cfg.tenantMembersCap || 10),
    db
      .prepare("INSERT OR IGNORE INTO members (handle, code_salt, code_hash, code_lookup, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tenants WHERE slug = ? AND name = ?)")
      .bind(identity, salt, hash, lookup, at, team, attempt),
    db.prepare("INSERT OR IGNORE INTO admin_members (handle) SELECT ? WHERE EXISTS (SELECT 1 FROM members WHERE handle = ? AND code_hash = ?)").bind(identity, identity, hash),
    db.prepare("UPDATE tenants SET name = ? WHERE slug = ? AND name = ?").bind(team, team, attempt),
  ]);
  if ((done[0]?.meta.changes ?? 0) !== 1) return null;
  await recordEvent(db, { kind: "console", name: "join", subject: identity, outcome: "ok" });
  return { ok: true, team, handle, identity, code };
}

/**
 * Deletes a hosted team at its admin's request: every member, their sign-ins and invitations, and the team's
 * name. Packets the team sent or received are revoked at once and removed by the cleanup within 7 days; files
 * not in a packet are claimed for deletion, so the next cleanup removes them. A team created later with the same
 * name and usernames sees none of it.
 */
export async function deleteTeam(db: D1Database, tenant: string): Promise<void> {
  if (!isValidTenant(tenant)) throw new Error(`not a team: ${tenant}`);
  const prefix = `${tenant}/`;
  const n = prefix.length;
  const { results } = await db.prepare("SELECT handle FROM members WHERE substr(handle, 1, ?) = ?").bind(n, prefix).all<{ handle: string }>();
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE packets SET revoked_at = ? WHERE (substr(owner, 1, ?) = ? OR substr(recipient, 1, ?) = ?) AND revoked_at IS NULL").bind(at, n, prefix, n, prefix),
    db
      .prepare(
        `UPDATE attachments SET claim = 'delete' WHERE substr(owner, 1, ?) = ? AND claim IS NULL
           AND NOT EXISTS (SELECT 1 FROM packet_attachments pa WHERE pa.attachment_id = attachments.id)`,
      )
      .bind(n, prefix),
    db.prepare("DELETE FROM invites WHERE substr(handle, 1, ?) = ?").bind(n, prefix),
    db.prepare("DELETE FROM member_sessions WHERE substr(handle, 1, ?) = ?").bind(n, prefix),
    db.prepare("DELETE FROM admin_members WHERE substr(handle, 1, ?) = ?").bind(n, prefix),
    db.prepare("DELETE FROM members WHERE substr(handle, 1, ?) = ?").bind(n, prefix),
    db.prepare("DELETE FROM tenants WHERE slug = ?").bind(tenant),
  ]);
  for (const r of results) await revokeAccess(db, r.handle, "*");
}
