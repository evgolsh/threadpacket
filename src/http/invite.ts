import { Hono } from "hono";
import type { Env } from "../env";
import type { Variables } from "../app";
import { CONSOLE_HEADERS, document, esc, flowHeader, interactiveHeaders, plural, type Html } from "../console/html";
import { sameOrigin, startSession } from "../console/session";
import { base64url } from "../domain/ids";
import { redeemInvitation, viewInvitation, type InviteView } from "../domain/invites";
import type { PacketWithFiles } from "../domain/service";
import { qualify } from "../domain/tenant";
import { COPY_SCRIPT } from "./clipboard";
import { claudeInstallLink } from "./meta";
import { packetHref } from "./packets-page";
import { REG_TICKS } from "./style";

const INVITE_CSS = `.invite-steps{margin:0;padding-left:20px;display:grid;gap:14px}.invite-steps li{line-height:1.5}.invite-steps p{margin:5px 0 0;font-size:12.5px;color:var(--muted)}
.invite-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.invite-actions .btn{width:auto}.invite-say{font-size:14.5px;font-weight:600;border-left:2px solid var(--accent);padding-left:10px;margin:6px 0 0}
.invite-packets{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}.invite-packets li{display:grid;gap:3px;padding:12px 14px;background:var(--ground);border:1px solid var(--line-soft);border-left:3px solid var(--accent);border-radius:7px}
.invite-packets a{font-weight:600;overflow-wrap:anywhere}.invite-packets span{font-size:12.5px;color:var(--muted)}.invite-open{width:auto;margin-bottom:22px}`;

function closed(v: InviteView | null): Html {
  const text = !v
    ? "This invitation link is not valid. Check that the whole link was copied."
    : v.state === "used"
      ? `This invitation was already used. Ask ${esc(v.invited_by)} for a new one: “invite ${esc(v.username)} to Threadpacket”.`
      : `This invitation expired. Ask ${esc(v.invited_by)} for a new one: “invite ${esc(v.username)} to Threadpacket”.`;
  return document(
    "Invitation",
    `${flowHeader("/", "About Threadpacket")}<main class="flow-wrap flow-single" id="main"><div class="dot-stage">${REG_TICKS}<div class="flow-card"><div class="stamp-bar"><span>Invitation // Threadpacket</span></div><section class="flow-panel"><h1>Invitation unavailable</h1><p class="flow-note">${text}</p></section></div></div></main>`,
    undefined,
    "Threadpacket",
  );
}

/** `from`: who sent them a packet that waits for them, if anyone did. Never its title: link previews see this page. */
function welcome(v: InviteView, token: string, from: string | null): Html {
  const team = v.team ? ` on team <strong>${esc(v.team)}</strong>` : "";
  return document(
    "You're invited",
    `${flowHeader("/", "About Threadpacket")}
<main class="flow-wrap flow-single" id="main">
  <div class="dot-stage">
    ${REG_TICKS}
    <div class="flow-card">
      <div class="stamp-bar"><span>Invitation // ${esc(v.team || "Threadpacket")}</span><span>@${esc(v.username)}</span></div>
      <form method="post" action="/invite/${esc(token)}" class="flow-panel">
        ${
          from
            ? `<div><h1>${esc(from)} sent you a packet.</h1><p class="flow-sub">Your username is <strong>${esc(v.username)}</strong>${team}. Continue to read it in your browser and get your one-time access code.</p></div>
        <button type="submit" class="btn primary">Continue →</button>`
            : `<div><h1>${esc(v.invited_by)} invited you.</h1><p class="flow-sub">Your username is <strong>${esc(v.username)}</strong>${team}. Reveal your one-time access code to connect your AI assistant.</p></div>
        <button type="submit" class="btn primary">Get my access code →</button>`
        }
        <p class="flow-note">Single-use link · expires ${esc(v.expires_at.slice(0, 10))} · <a href="/privacy">Privacy</a></p>
      </form>
    </div>
  </div>
</main>`,
    undefined,
    "Threadpacket",
  );
}

/** Packets sent to the invitee before they opened the link: each one's title, sender and files, linked to read in the browser. */
function waitingPackets(waiting: PacketWithFiles[]): Html {
  const items = waiting
    .map((p) => `<li><a href="${packetHref(p.packet_id)}" target="_blank" rel="noopener">${esc(p.title)}</a><span>From ${esc(p.from)} · ${p.attachments.length ? plural(p.attachments.length, "file") : "brief only"}</span></li>`)
    .join("");
  const open = waiting.length === 1 ? { href: packetHref(waiting[0]!.packet_id), label: "Open the packet" } : { href: "/packets?show=received", label: "Open your packets" };
  return `<ul class="invite-packets">${items}</ul><a class="btn primary invite-open" href="${open.href}" target="_blank" rel="noopener">${open.label} ↗</a>`;
}

function credentials(v: InviteView, code: string, publicUrl: string, nonce: string, waiting: PacketWithFiles[], signedIn: boolean): Html {
  const mcp = `${publicUrl}/mcp`;
  const host = new URL(publicUrl).host;
  const details = `Threadpacket\nServer: ${mcp}\nUsername: ${v.username}\nAccess code: ${code}`;
  const senders = [...new Set(waiting.map((p) => p.from))];
  const intro = !waiting.length
    ? `<h1>Save your access code.</h1><p>Shown once. Save it before connecting your assistant.</p>`
    : `<h1>${waiting.length === 1 ? `${esc(waiting[0]!.from)} sent you a packet.` : `${waiting.length} packets are waiting for you.`}</h1><p>Read the brief and download the files in your browser. No assistant needed.</p>${waitingPackets(waiting)}<p>Save your access code below. It is shown once, and you need it to reply or to connect your assistant.</p>`;
  const from = senders.length === 1 ? senders[0]! : v.invited_by;
  return document(
    waiting.length ? "A packet for you" : "Your access code",
    `${flowHeader("/", "About Threadpacket", true)}<div class="flow-wrap"><div class="flow-grid">
  <section class="flow-intro"><div class="flow-complete">✓ Joined${v.team ? ` ${esc(v.team)}` : ""}</div>${intro}
    <dl class="credential-meta">${v.team ? `<div><dt>Team</dt><dd>${esc(v.team)}</dd></div>` : ""}<div><dt>Username</dt><dd>${esc(v.username)}</dd></div></dl>
    <div><span class="lbl small muted">Access code</span><div class="secret" aria-label="access code">${esc(code)}</div><button type="button" class="btn" data-copy="${esc(details)}">Copy sign-in details</button><p id="copy-status" class="sr-only" role="status"></p></div>
  </section>
  <section class="flow-panel"><ol class="invite-steps">
    <li><strong>Connect your assistant</strong>
      <div class="invite-actions"><a class="btn${waiting.length ? "" : " primary"}" href="${esc(claudeInstallLink(mcp))}" target="_blank" rel="noopener">Add to Claude ↗</a><a class="btn" href="/connect" target="_blank" rel="noopener">ChatGPT &amp; others ↗</a></div>
      <p>In Claude, add <code>${esc(host)}</code> to allowed domains under Settings &gt; Capabilities so file attachments work.</p></li>
    <li><strong>Sign in</strong> with username <strong>${esc(v.username)}</strong> and your access code.</li>
    <li><strong>Ask your assistant:</strong><p class="invite-say">“Continue the packet from ${esc(from)}.”</p></li>
  </ol>
  <p class="flow-note">${signedIn ? `This browser is signed in as ${esc(v.username)}. ` : ""}Open packets or upload phone scans in <a href="/packets" target="_blank" rel="noopener">Packets ↗</a>.</p></section>
</div></div>`,
    { nonce, script: COPY_SCRIPT, style: INVITE_CSS },
    "Threadpacket",
  );
}

const noIndex = { "x-robots-tag": "noindex" };

export function inviteRoutes(): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  /** Packets sent straight to the invitee that they have not opened yet, newest first. */
  const waitingFor = async (c: { get: (k: "service") => Variables["service"] }, v: InviteView): Promise<PacketWithFiles[]> => {
    const unseen = await c.get("service").unseen({ subject: qualify(v.team, v.username), scopes: [], clientId: "packets", token: "" });
    return unseen.filter((p) => p.to === v.username);
  };

  app.get("/invite/:token", async (c) => {
    const token = c.req.param("token");
    const v = await viewInvitation(c.env.DB, token);
    const body = v && v.state === "open" ? welcome(v, token, (await waitingFor(c, v))[0]?.from ?? null) : closed(v);
    return new Response(body, { status: v ? 200 : 404, headers: { ...CONSOLE_HEADERS, ...noIndex } });
  });
  app.post("/invite/:token", async (c) => {
    const token = c.req.param("token");
    const r = await redeemInvitation(c.env.DB, token);
    if (!r) {
      const v = await viewInvitation(c.env.DB, token);
      return new Response(closed(v), { status: v ? 410 : 404, headers: { ...CONSOLE_HEADERS, ...noIndex } });
    }
    const cfg = c.get("cfg");
    const identity = qualify(r.view.team, r.view.username);
    // Opening the link signs this browser in, as creating a team does, so packets sent to them open right away.
    // Only for the form on this site's own invitation page, so another site cannot sign a browser in to its account.
    const cookie = sameOrigin(c.req.header("origin"), cfg.publicUrl) ? await startSession(c.env.DB, identity, c.req.header("cookie")) : null;
    const waiting = await waitingFor(c, r.view);
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const headers = new Headers({ ...interactiveHeaders(nonce), ...noIndex });
    if (cookie) headers.append("set-cookie", cookie);
    return new Response(credentials(r.view, r.code, cfg.publicUrl, nonce, waiting, !!cookie), { headers });
  });
  return app;
}
