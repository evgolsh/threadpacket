// Renders the hosted X launch walkthrough, docs/threadpacket-hosted-demo.mp4:
//   1. Connect (hosted threadpacket.com via Hermes catalog plugin, no server deploy)
//   2. Send (joe in Hermes sends brief + 2 original PDFs to anna)
//   3. Continue (anna in ChatGPT reads brief + original PDFs byte for byte)
//   4. Private (closing card: free at threadpacket.com, or self-host on Cloudflare for full privacy)
//
// Usage:
//   node scripts/demo-video/render-hosted.mjs                render full 1920x1080 30fps MP4
//   node scripts/demo-video/render-hosted.mjs --still=4.5    render single PNG frame at 4.5 s
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_ICON, HERMES_MASK, OPENAI_ICON } from "../../src/http/assistant-icons.ts";
import { BASE_CSS, BRAND_ICON, FILE_ICON } from "../../src/http/style.ts";

const W = 960, H = 540, SCALE = 2, FPS = 30, DURATION = 28;
const OUT = "docs/threadpacket-hosted-demo.mp4";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

const T = {
  // Step 1: Connect hosted (0.0 -> 6.8s)
  connect: 0,
  cmd1: 0.35,
  cmd1Done: 1.55,
  cmd2: 1.95,
  signin: 2.55,
  user: 3.15,
  team: 3.75,
  allow: 4.55,
  connected: 5.15,
  connectOut: 6.75,

  // Step 2: Send from Hermes (7.0 -> 14.3s)
  send: 7.0,
  joeAsks: 7.35,
  sendTool: 8.25,
  brief1: 8.65,
  brief2: 9.05,
  sent: 9.75,
  sentReply: 10.15,
  files1: 10.75,
  path: 11.45,
  travel: 11.75,

  // Step 3: Continue in ChatGPT (14.4 -> 21.4s)
  cont: 14.4,
  annaAsks: 14.65,
  read: 15.45,
  readDone: 16.35,
  files2: 16.65,
  same: 17.15,
  reply: 17.55,
  stageOut: 21.45,

  // Step 4: Closing card (21.8 -> 28.0s)
  closing: 21.8,
  closeCard: 22.15,
  closePrivate: 22.95,
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FILES = ["renewal-quote.pdf", "policy-terms.pdf"];
const at = (s) => `--in:${s}s`;
const io = (a, b) => `--in:${a}s;--out:${b}s`;
const type = (text, start, perSecond = 42) =>
  `<span class="type" style="${at(start)};--n:${text.length};--d:${(text.length / perSecond).toFixed(2)}s">${esc(text)}</span>`;
const line = (start, html) => `<div class="in" style="${at(start)}">${html}</div>`;
const fileTags = (start) =>
  `<ul class="file-tags">${FILES.map((f, i) => `<li class="in" style="${at(start + i * 0.2)}">${FILE_ICON}${f}</li>`).join("")}</ul>`;
const words = (text, start, step = 0.05) =>
  text
    .split(" ")
    .map((w, i) => {
      const inner = w.startsWith("`") ? `<code>${w.replace(/`/g, "")}</code>` : w;
      return `<span class="w" style="${at((start + i * step).toFixed(3))}">${inner}</span>`;
    })
    .join(" ");
const toolState = (start, done) =>
  `<span class="state"><i class="spin" style="${io(start, done)}"></i><i class="done in" style="${at(done)}">✓</i></span>`;
const HERMES_ICON = `<span class="hermes-mark" aria-hidden="true"></span>`;

const STEPS = [
  ["Connect", T.connect, T.send],
  ["Send", T.send, T.cont],
  ["Continue", T.cont, T.closing],
  ["Private", T.closing, DURATION + 1],
];

const CSS = `
  html,body { width:${W}px; height:${H}px; overflow:hidden; background:var(--ground); color:var(--ink); }
  body { position:relative; font-family:var(--sans); }
  p,h1,h2,h3 { margin:0; }

  .bar { position:absolute; inset:0 0 auto; height:46px; padding:0 24px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); }
  .brand { display:inline-flex; align-items:center; gap:8px; font-size:14px; font-weight:600; letter-spacing:-.01em; }
  .brand svg { width:22px; height:22px; }
  .url { font:500 12px var(--mono); color:var(--muted); }
  .steps { display:flex; gap:6px; }
  .tab { position:relative; isolation:isolate; padding:5px 11px; border-radius:6px; font-size:12px; color:var(--muted); }
  .tab b { font:500 11px var(--mono); margin-right:6px; color:var(--faint); }
  .tab i { position:absolute; inset:0; border:1px solid var(--line); border-radius:6px; background:var(--panel); z-index:-1; }
  .tab .on { position:absolute; inset:0; padding:5px 11px; color:var(--ink); font-weight:500; }
  .tab .off { animation:hide .25s var(--in) forwards, show .25s var(--out) forwards; }
  .tab .on b { color:var(--accent); }

  .caption { position:absolute; left:24px; right:24px; top:60px; text-align:center; font-size:17px; font-weight:500; letter-spacing:-.01em; }
  .caption code { font:500 15px var(--mono); color:var(--accent); }
  .scene { position:absolute; left:24px; right:24px; top:100px; bottom:22px; }

  .hermes-mark { display:inline-block; width:16px; height:16px; flex:none; background:currentColor;
    -webkit-mask:url("${HERMES_MASK}") center/contain no-repeat; mask:url("${HERMES_MASK}") center/contain no-repeat; }

  /* Step 1: Connect hosted */
  .connect { height:100%; display:grid; grid-template-columns:1.08fr 0.92fr; gap:22px; align-items:center; }
  .left-col { display:flex; flex-direction:column; gap:14px; }
  .term { background:#141413; border-radius:10px; box-shadow:0 12px 28px #00000018; overflow:hidden; }
  .term-top { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:#1f1f1e; font:11px var(--mono); color:#9c9b94; }
  .term-dots { display:flex; align-items:center; gap:7px; }
  .term-dots i { width:9px; height:9px; border-radius:50%; background:#3a3a38; }
  .term-top .badge { color:#6cc27a; }
  .term-body { padding:16px 18px 18px; font:13px/1.75 var(--mono); color:#ecece8; white-space:pre; min-height:178px; }
  .term-body .p { color:#7aa7ff; }
  .term-body .ok { color:#6cc27a; }
  .term-body .dim { color:#8f8f8a; }
  .type { display:inline-block; vertical-align:bottom; overflow:hidden; white-space:pre; width:0;
          animation:typing var(--d) steps(var(--n), end) var(--in) both; }

  .clients-card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; display:flex; flex-direction:column; gap:8px; }
  .clients-label { font:500 11px var(--mono); letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
  .clients-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .client-chip { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:500; color:var(--ink); }
  .client-chip svg, .client-chip .hermes-mark { width:15px; height:15px; }
  .endpoint-pill { font:500 12px var(--mono); color:var(--accent); background:var(--select); padding:4px 9px; border-radius:6px; align-self:flex-start; }

  .signin-wrap { display:flex; flex-direction:column; gap:6px; }
  .signin-wrap .brand { font-size:16px; margin-bottom:2px; }
  .signin-wrap .tagline { font-size:13px; color:var(--muted); margin-bottom:6px; }
  .signin { background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 28px #0000000a; padding:18px; display:flex; flex-direction:column; gap:11px; }
  .signin .meta { font-size:12.5px; line-height:1.45; color:var(--muted); }
  .signin .meta strong { color:var(--ink); }
  .field label { display:block; font-size:12px; font-weight:500; margin-bottom:4px; }
  .input { min-height:34px; padding:7px 11px; border:1px solid var(--line); border-radius:6px; background:var(--ground); font:13px/1.35 var(--mono); }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:36px; padding:8px 16px; border-radius:6px; background:var(--ink); color:var(--ground); font-size:13px; font-weight:500; width:100%; }
  .press { animation:press .35s var(--in) both; }
  .connected { font-size:12.5px; font-weight:500; color:var(--ok); text-align:center; }

  /* Step 2 & 3: Send + Continue */
  .stage { height:100%; display:grid; grid-template-columns:minmax(0,1fr) 128px minmax(0,1fr); }
  .chat { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 18px 14px; box-shadow:0 12px 28px #0000000a; display:flex; flex-direction:column; gap:11px; }
  .chat-app { display:flex; justify-content:space-between; align-items:center; padding-bottom:10px; border-bottom:1px solid var(--line-soft); font-size:12px; color:var(--muted); }
  .app { display:inline-flex; align-items:center; gap:7px; color:var(--ink); font-weight:600; font-size:13px; }
  .app svg, .app .hermes-mark { width:16px; height:16px; flex:none; }
  .msg-user { align-self:flex-end; max-width:92%; padding:8px 13px; background:var(--ground); border:1px solid var(--line-soft); border-radius:16px 16px 4px 16px; font-size:14px; line-height:1.45; }
  .tool-step { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); }
  .tool-step b { color:var(--ink); font-weight:500; }
  .state { position:relative; width:14px; height:14px; flex:none; }
  .state i { position:absolute; inset:0; font-style:normal; }
  .spin { border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%;
          animation:spin .8s linear infinite, vanish .2s var(--out) forwards; }
  .done { color:var(--ok); font-size:13px; line-height:14px; font-weight:600; text-align:center; }
  .brief { margin:8px 0 0 22px; padding:9px 12px; border-left:2px solid var(--accent); background:var(--ground); border-radius:0 6px 6px 0; font-size:13px; line-height:1.48; }
  .brief b { display:block; font-weight:600; }
  .brief p { margin-top:2px; color:var(--muted); }
  .msg-assistant { font-size:13.8px; line-height:1.52; }
  .msg-assistant code { font:500 12.5px var(--mono); white-space:nowrap; }
  .file-tags { display:flex; gap:6px; flex-wrap:wrap; list-style:none; margin:0; padding:0; }
  .file-tags li { display:inline-flex; align-items:center; gap:6px; font:500 11px/1.5 var(--mono); padding:5px 8px; background:var(--ground); border:1px solid var(--line); border-radius:5px; }
  .file-tags svg,.token svg { width:13px; height:13px; flex:none; color:var(--accent); }
  .files-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .same { font-size:12px; font-weight:600; color:var(--ok); }
  .composer { margin-top:auto; padding:9px 14px; border:1px solid var(--line); border-radius:18px; font-size:12.5px; color:var(--faint); display:flex; justify-content:space-between; align-items:center; }
  .pickup-badge { font:500 11.5px var(--sans); color:var(--ok); }

  .path { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:0 6px; text-align:center; }
  .path-label { font:500 11px/1.45 var(--mono); letter-spacing:.06em; color:var(--accent); }
  .track { position:relative; width:100%; height:30px; }
  .track > i { position:absolute; left:0; right:12px; top:50%; height:1px; background:var(--accent); opacity:.45; }
  .track > b { position:absolute; right:0; top:50%; transform:translateY(-55%); color:var(--accent); font-size:15px; font-weight:400; }
  .token { position:absolute; top:50%; display:flex; gap:3px; align-items:center; padding:5px 7px; background:var(--panel); border:1px solid var(--accent); border-radius:7px; box-shadow:0 4px 12px #2450e026;
           animation:travel 1.6s var(--in) both cubic-bezier(.55,0,.3,1); }
  .token svg:first-child { color:var(--ink); width:14px; height:14px; }
  .path-note { font-size:11px; line-height:1.45; color:var(--muted); }
  .path-note strong { display:block; color:var(--ink); font-weight:500; }

  /* Step 4: Closing card (Hosted + Self-host Private note) */
  .closing-stage { height:100%; border:1px solid var(--line); border-radius:12px; background-color:var(--stage);
    background-image:radial-gradient(var(--dot) 1px, transparent 1px); background-size:18px 18px;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; padding:26px 40px; }
  .close-hero { text-align:center; display:flex; flex-direction:column; align-items:center; gap:10px; max-width:700px; }
  .close-hero .brand-lg { display:inline-flex; align-items:center; gap:10px; font-size:17px; font-weight:600; color:var(--ink); }
  .close-hero .brand-lg svg { width:26px; height:26px; }
  .close-hero h1 { font-size:31px; font-weight:600; letter-spacing:-.02em; line-height:1.15; color:var(--ink); }
  .close-hero h1 span { color:var(--accent); }
  .close-hero .sub { font-size:15px; line-height:1.5; color:var(--muted); }
  .close-pills { display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap; margin-top:2px; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:5px 11px; background:var(--panel); border:1px solid var(--line); border-radius:999px; font-size:12.5px; font-weight:500; color:var(--ink); }
  .pill svg, .pill .hermes-mark { width:14px; height:14px; }
  .close-facts { font:500 12px var(--mono); color:var(--muted); letter-spacing:.01em; margin-top:2px; }

  .private-card { width:100%; max-width:720px; background:var(--panel); border:1px solid var(--line); border-left:3.5px solid var(--accent);
    border-radius:10px; padding:16px 22px; box-shadow:0 10px 24px #0000000d; display:flex; align-items:center; justify-content:space-between; gap:20px; }
  .private-copy { display:flex; flex-direction:column; gap:4px; }
  .private-eyebrow { font:500 11px var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--accent); }
  .private-title { font-size:16px; font-weight:600; color:var(--ink); }
  .private-desc { font-size:13px; line-height:1.45; color:var(--muted); }
  .private-repo { flex:none; font:500 12px var(--mono); color:var(--ink); background:var(--subtle); border:1px solid var(--line); padding:8px 12px; border-radius:7px; text-align:right; }
  .private-repo span { display:block; font:400 11px var(--sans); color:var(--muted); margin-top:2px; }

  .in { animation:appear .4s var(--in) both cubic-bezier(.2,.7,.2,1); }
  .io { animation:appear .4s var(--in) both cubic-bezier(.2,.7,.2,1), vanish .35s var(--out) forwards; }
  .fade { animation:show .25s var(--in) both, hide .25s var(--out) forwards; }
  .w { animation:show .22s var(--in) both; }
  @keyframes appear { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes vanish { to { opacity:0; transform:translateY(-6px); } }
  @keyframes show { from { opacity:0; } to { opacity:1; } }
  @keyframes hide { to { opacity:0; } }
  @keyframes spin { to { transform:rotate(360deg); } }
  @keyframes typing { from { width:0; } to { width:calc(var(--n) * 1ch); } }
  @keyframes press { 0% { transform:none; } 40% { transform:scale(.96); background:var(--accent); } 100% { transform:none; background:var(--accent); } }
  @keyframes travel {
    0% { left:-44px; opacity:0; transform:translateY(-50%) scale(.8); }
    15% { opacity:1; transform:translateY(-50%) scale(1); }
    85% { opacity:1; transform:translateY(-50%) scale(1); }
    100% { left:calc(100% + 8px); opacity:0; transform:translateY(-50%) scale(.9); }
  }
`;

const steps = STEPS.map(
  ([name, from, to], i) =>
    `<span class="tab"><i class="fade" style="${io(from, to)}"></i><span class="off" style="${io(from, to)}"><b>${i + 1}</b>${name}</span><span class="on fade" style="${io(from, to)}"><b>${i + 1}</b>${name}</span></span>`,
).join("");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Threadpacket hosted walkthrough</title>
<style>${BASE_CSS}${CSS}</style></head><body>
<header class="bar"><span class="brand">${BRAND_ICON}Threadpacket</span><nav class="steps">${steps}</nav><span class="url">threadpacket.com</span></header>

<!-- Step 1: Connect hosted -->
<p class="caption io" style="${io(T.connect + 0.01, T.connectOut)}">Connect to <code>threadpacket.com/mcp</code> in seconds. Free, no server to deploy.</p>
<section class="scene io" style="${io(T.connect + 0.01, T.connectOut)}">
  <div class="connect">
    <div class="left-col">
      <div class="term in" style="${at(0.1)}">
        <div class="term-top"><span class="term-dots"><i></i><i></i><i></i><span>Hermes Agent</span></span><span class="badge">plugin catalog</span></div>
        <div class="term-body">${[
          line(T.cmd1, `<span class="p">$</span> ${type("hermes plugins install threadpacket", T.cmd1, 36)}`),
          line(T.cmd1Done, `<span class="ok">✓</span> Installed threadpacket <span class="dim">(6 tools + skill)</span>`),
          line(T.cmd2, `\n<span class="p">$</span> ${type("hermes mcp login threadpacket", T.cmd2, 38)}`),
          line(T.signin, `<span class="dim">Opening https://threadpacket.com/oauth...</span>`),
          line(T.connected, `\n<span class="ok">✓ Signed in as joe (team smiths)</span>`),
        ].join("")}</div>
      </div>
      <div class="clients-card in" style="${at(0.25)}">
        <span class="clients-label">One hosted MCP endpoint for every agent</span>
        <span class="endpoint-pill">https://threadpacket.com/mcp</span>
        <div class="clients-row">
          <span class="client-chip">${HERMES_ICON}Hermes</span>
          <span class="client-chip">${CLAUDE_ICON}Claude &amp; Claude Code</span>
          <span class="client-chip">${OPENAI_ICON}ChatGPT &amp; Codex</span>
        </div>
      </div>
    </div>
    <div class="signin-wrap in" style="${at(T.signin)}">
      <div class="brand">${BRAND_ICON}<span>Threadpacket</span></div>
      <p class="tagline">No email, no phone number, no API keys.</p>
      <div class="signin">
        <p class="meta"><strong>Create a team</strong> on <code>threadpacket.com</code>. Pick a username and save your access code once.</p>
        <div class="field"><label>Username</label><div class="input">${type("joe", T.user, 14)}</div></div>
        <div class="field"><label>Team</label><div class="input">${type("smiths", T.team, 18)}</div></div>
        <span class="btn press" style="${at(T.allow)}">Create team and allow</span>
        <span class="connected in" style="${at(T.connected)}">✓ Connected to threadpacket.com</span>
      </div>
    </div>
  </div>
</section>

<!-- Step 2 & 3: Send + Continue -->
<p class="caption io" style="${io(T.send, T.cont - 0.15)}">joe finishes the renewal in Hermes, then sends a packet to anna with both PDFs.</p>
<p class="caption io" style="${io(T.cont, T.stageOut)}">anna continues in ChatGPT with joe’s brief and the original files.</p>
<section class="scene io" style="${io(T.send, T.stageOut)}">
  <div class="stage">
    <div class="chat">
      <div class="chat-app"><b class="app">${HERMES_ICON}Hermes</b><span>joe, Mac mini</span></div>
      <p class="msg-user in" style="${at(T.joeAsks)}">Send a packet to anna with the two PDFs.</p>
      <div class="in" style="${at(T.sendTool)}">
        <p class="tool-step">${toolState(T.sendTool, T.sent)}<span>Send a packet</span></p>
        <div class="brief"><b class="in" style="${at(T.brief1)}">Car insurance renewal</b><p class="in" style="${at(T.brief2)}">Keep the $500 deductible. Confirm glass coverage and sign before Friday.</p></div>
      </div>
      <p class="msg-assistant">${words("Sent to anna with both PDFs. Auto-deletes in 7 days.", T.sentReply)}</p>
      ${fileTags(T.files1)}
      <p class="pickup-badge in" style="${at(T.readDone)}">✓ Picked up by anna in ChatGPT</p>
      <p class="composer"><span>Ask Hermes</span></p>
    </div>
    <div class="path">
      <p class="path-label in" style="${at(T.path)}">A PACKET<br>BRIEF + FILES</p>
      <div class="track in" style="${at(T.path)}"><i></i><span class="token" style="${at(T.travel)}">${BRAND_ICON}${FILE_ICON}${FILE_ICON}</span><b>→</b></div>
      <p class="path-note in" style="${at(T.path + 0.3)}"><strong>threadpacket.com</strong>Any file up to 25 MiB<br>Expires in 7 days</p>
    </div>
    <div class="chat">
      <div class="chat-app"><b class="app">${OPENAI_ICON}ChatGPT</b><span>anna, laptop</span></div>
      <p class="msg-user in" style="${at(T.annaAsks)}">Continue the packet from joe.</p>
      <p class="tool-step in" style="${at(T.read)}">${toolState(T.read, T.readDone)}<span>Read a packet</span><b class="in" style="${at(T.readDone)}">Car insurance renewal, 2 files</b></p>
      <div class="files-row">${fileTags(T.files2)}<span class="same in" style="${at(T.same)}">✓ Byte for byte</span></div>
      <p class="msg-assistant">${words("Got joe’s brief and both PDFs. Glass coverage is included with the $500 deductible in `policy-terms.pdf`. Ready to draft the confirmation.", T.reply)}</p>
      <p class="composer"><span>Ask anything</span></p>
    </div>
  </div>
</section>

<!-- Step 4: Closing card -->
<p class="caption in" style="${at(T.closing)}">Ready in under a minute. Free hosted, or private on your own server.</p>
<section class="scene in" style="${at(T.closing)}">
  <div class="closing-stage">
    <div class="close-hero in" style="${at(T.closeCard)}">
      <div class="brand-lg">${BRAND_ICON}<span>Threadpacket</span></div>
      <h1>Free hosted at <span>threadpacket.com</span></h1>
      <p class="sub">Ephemeral packets between AI agents: your brief + original files up to 25 MiB.</p>
      <div class="close-pills">
        <span class="pill">${HERMES_ICON}Hermes</span>
        <span class="pill">${CLAUDE_ICON}Claude &amp; Claude Code</span>
        <span class="pill">${OPENAI_ICON}ChatGPT &amp; Codex</span>
      </div>
      <p class="close-facts">No email or phone · Auto-deletes in 7 days · No AI calls on the server</p>
    </div>
    <div class="private-card in" style="${at(T.closePrivate)}">
      <div class="private-copy">
        <span class="private-eyebrow">MIT Open Source · Everything Private</span>
        <p class="private-title">Or host it yourself and keep everything private.</p>
        <p class="private-desc">Deploy to your own Cloudflare account (free tier, no card). Your database, your files, nothing touches our server.</p>
      </div>
      <div class="private-repo">github.com/evgolsh/threadpacket<span>Free tier · Cloudflare Workers</span></div>
    </div>
  </div>
</section>
</body></html>`;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!existsSync("public/fonts")) fail("public/fonts is missing.");
if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}.`);
const stillArg = process.argv.find((a) => a.startsWith("--still="));
const stills = stillArg ? stillArg.slice("--still=".length).split(",").map(Number) : null;
if (!stills && spawnSync(FFMPEG, ["-version"]).status !== 0) fail(`ffmpeg not found at ${FFMPEG}.`);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  const font = path.match(/^\/fonts\/([\w.-]+\.woff2)$/);
  if (font) {
    res.writeHead(200, { "content-type": "font/woff2" });
    return res.end(readFileSync(join("public/fonts", font[1])));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "threadpacket-hosted-chrome-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--force-color-profile=srgb", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const browserUrl = await new Promise((resolve, reject) => {
  let log = "";
  chrome.stderr.on("data", (d) => {
    log += d;
    const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}):\n${log}`)));
});
const page = await (await fetch(`http://127.0.0.1:${new URL(browserUrl).port}/json/new?about:blank`, { method: "PUT" })).json();

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
    else p.resolve(m.result);
  } else if (waiting.has(m.method)) {
    waiting.get(m.method)(m.params);
    waiting.delete(m.method);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((resolve) => waiting.set(method, resolve));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: `${origin}/` });
  await loaded;
  await evaluate(`Promise.all([
    ...["400 1em 'IBM Plex Sans'", "500 1em 'IBM Plex Sans'", "600 1em 'IBM Plex Sans'", "400 1em 'IBM Plex Mono'", "500 1em 'IBM Plex Mono'"].map((f) => document.fonts.load(f)),
    ...[...document.images].map((i) => i.decode()),
  ]).then(() => true)`);
  await evaluate(`window.seek = (ms) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
  }; true`);
  const frame = async (seconds) => {
    await evaluate(`seek(${seconds * 1000})`);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  };

  if (stills) {
    for (const s of stills) {
      const out = join(tmpdir(), `threadpacket-hosted-${s}s.png`);
      writeFileSync(out, await frame(s));
      console.log(out);
    }
  } else {
    const dir = mkdtempSync(join(tmpdir(), "threadpacket-hosted-frames-"));
    const total = Math.round(DURATION * FPS);
    for (let i = 0; i < total; i++) {
      writeFileSync(join(dir, `${String(i).padStart(5, "0")}.png`), await frame(i / FPS));
      if (i % FPS === 0) process.stdout.write(`\rframes: ${i / FPS} of ${DURATION} s`);
    }
    process.stdout.write(`\rframes: ${DURATION} of ${DURATION} s\n`);
    const enc = spawnSync(
      FFMPEG,
      ["-y", "-v", "error", "-framerate", String(FPS), "-i", join(dir, "%05d.png"), "-c:v", "libx264", "-preset", "slow",
        "-crf", "20", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT],
      { stdio: "inherit" },
    );
    rmSync(dir, { recursive: true, force: true });
    if (enc.status !== 0) throw new Error("ffmpeg failed");
    console.log(`${OUT} written`);
  }
} finally {
  ws.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await exited;
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
