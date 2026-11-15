import type { Config } from "../env";
import { createTeam } from "../domain/teams";
import { NEW_HANDLE_PATTERN, NEW_HANDLE_RULE, TEAM_NAME_PATTERN } from "../auth/builtin";
import { AVAIL_CSS, TEAM_CHECK_SCRIPT } from "./team-check";
import { CONSOLE_HEADERS, NOT_A_SIGN_IN, document, esc, flowHeader, interactiveHeaders, type Html } from "../console/html";
import { startSession } from "../console/session";
import { COPY_SCRIPT } from "./clipboard";
import { REG_TICKS } from "./style";

export function joinPage(cfg: Config, opts: { error?: string; team?: string; handle?: string } = {}, nonce = ""): Html {
  return document(
    "Create a team",
    `${flowHeader()}
<main class="flow-wrap flow-single" id="main">
  <div class="dot-stage">
    ${REG_TICKS}
    <div class="flow-card">
      <div class="stamp-bar"><span>New team // Threadpacket, hosted</span><span>No email required</span></div>
      ${
        cfg.signupsOpen
          ? ""
          : `<section class="flow-panel">
        <div><h1>Sign-up is paused.</h1><p class="flow-sub">The hosted service is not taking new teams for now. Try again later, or ask a team's admin to invite you.</p></div>
        <div class="flow-switch"><span>Already have an access code?</span><a class="u" href="/login">Sign in →</a></div>
      </section>`
      }${cfg.signupsOpen ? `
      <form method="post" action="/join" class="flow-panel" autocomplete="off" data-team-check>
        <div><h1>Create a team.</h1><p class="flow-sub">No email or phone number. Pick a username to get your access code.</p></div>
        ${opts.error ? `<div class="flash" role="alert">${esc(opts.error)}</div>` : ""}
        <div><label class="lbl" for="handle">Your name</label><input id="handle" name="handle" class="field" required autofocus minlength="3" maxlength="63" pattern="${NEW_HANDLE_PATTERN}" title="${NEW_HANDLE_RULE}" autocapitalize="none" spellcheck="false" placeholder="joe" value="${esc(opts.handle ?? "")}" ${NOT_A_SIGN_IN}><p class="field-help" data-avail="handle" aria-live="polite"></p></div>
        <div><label class="lbl" for="team">Team or family name <span class="muted">(optional)</span></label><input id="team" name="team" class="field" maxlength="32" pattern="${TEAM_NAME_PATTERN}" autocapitalize="none" spellcheck="false" placeholder="smiths" value="${esc(opts.team ?? "")}" aria-describedby="team-help"><p class="field-help" id="team-help" data-avail="team" data-help="Leave it empty to use your username." aria-live="polite">Leave it empty to use your username.</p></div>
        <button type="submit" class="btn primary">Create team →</button>
        <div class="flow-switch"><span>Already have an access code?</span><a class="u" href="/login">Sign in →</a></div>
      </form>` : ""}
    </div>
  </div>
</main>`,
    nonce && cfg.signupsOpen ? { nonce, script: TEAM_CHECK_SCRIPT, style: AVAIL_CSS } : undefined,
    "Threadpacket",
  );
}

export function joinedPage(team: string, handle: string, code: string, signedIn: boolean, nonce: string, publicUrl: string): Html {
  const details = `Threadpacket\nServer: ${publicUrl}/mcp\nUsername: ${handle}\nAccess code: ${code}\nSetup: ${publicUrl}/connect`;
  return document(
    "Team created",
    `${flowHeader("/", "About Threadpacket", true)}
<main class="flow-wrap flow-single" id="main">
  <div class="dot-stage">
    ${REG_TICKS}
    <div class="flow-card">
      <div class="stamp-bar"><span>Access code // shown once</span><span>✓ Team ${esc(team)} is ready</span></div>
      <section class="flow-panel">
        <div><h1>Save your access code.</h1><p class="flow-sub">Store it in your password manager before continuing.</p></div>
        <dl class="credential-meta"><div><dt>Team</dt><dd>${esc(team)}</dd></div><div><dt>Username</dt><dd>${esc(handle)}</dd></div></dl>
        <div><span class="lbl small muted">Your access code</span><div class="secret" aria-label="access code">${esc(code)}</div><button type="button" class="btn" data-copy="${esc(details)}">Copy sign-in details</button></div>
        ${signedIn ? `<div class="flow-note">Signed in as ${esc(handle)} · team admin</div>` : '<div class="flash">Save the code above, then sign in to continue.</div>'}
        <a class="btn primary" href="${signedIn ? "/connect" : "/login?next=%2Fconnect"}">Continue to setup →</a>
        <p id="copy-status" class="sr-only" role="status"></p>
      </section>
    </div>
  </div>
</main>`,
    { nonce, script: COPY_SCRIPT },
    "Threadpacket",
  );
}

/** With a nonce the page runs the live team-name check, which fetches /join/check from this site. */
export const joinHeaders = (nonce?: string): Record<string, string> => {
  if (!nonce) return { ...CONSOLE_HEADERS };
  const headers = interactiveHeaders(nonce);
  return { ...headers, "content-security-policy": `${headers["content-security-policy"]}; connect-src 'self'` };
};

export async function handleJoin(
  db: D1Database,
  cfg: Config,
  form: Record<string, string>,
  ip: string | undefined,
  nonce: string,
  header?: string,
): Promise<{ status: number; body: Html; cookies?: string[] }> {
  const made = await createTeam(db, cfg, form.team ?? "", form.handle ?? "", ip);
  if (!made.ok) return { status: made.status, body: joinPage(cfg, { error: made.error, team: made.team, handle: made.handle }, nonce) };
  const { team, handle, identity, code } = made;
  let cookie: string | null = null;
  try {
    cookie = await startSession(db, identity, header);
  } catch {
    cookie = null;
  }
  return { status: 200, body: joinedPage(team, handle, code, cookie !== null, nonce, cfg.publicUrl), cookies: cookie ? [cookie] : [] };
}
