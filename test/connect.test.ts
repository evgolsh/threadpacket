import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import worker from "../src/index";
import { ORIGIN } from "./helpers";
import { FONT_FILES } from "../src/http/style";
import { DEPLOY_PATH, INSTALL_URL, GITHUB_URL } from "../src/http/header";

/** The homepage is served by the control center (THREADPACKET_MODE=control); a private install sends / to /connect. */
const control = { ...env, THREADPACKET_MODE: "control" };
const home = (path = "/") => worker.fetch(new Request(`${ORIGIN}${path}`), control, createExecutionContext());

describe("connect and homepage (Courier Hybrid)", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO members (handle, code_salt, code_hash, created_at) VALUES ('tim', 's', 'h', '2026-10-27T00:00:00Z')"),
      env.DB.prepare("INSERT OR IGNORE INTO admin_members (handle) VALUES ('tim')"),
    ]);
  });

  it("/connect shows the stamped MCP server bar and setup steps for each host on an active instance", async () => {
    const res = await SELF.fetch(`${ORIGIN}/connect`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`data-copy="${ORIGIN}/mcp"`);
    expect(html).toContain(`claude mcp add --transport http --scope user threadpacket ${ORIGIN}/mcp`);
    expect(html).toContain("<code>hermes plugins install threadpacket</code>");
    expect(html).toContain('<a href="https://hermes-agent.nousresearch.com/docs/plugins/threadpacket" target="_blank" rel="noopener">Hermes catalog</a>');
    expect(html).toContain(`hermes mcp add threadpacket --url ${ORIGIN}/mcp --auth oauth`);
    expect(html).toContain("<code>trust: untrusted</code>");
    expect(html).toContain(`codex mcp add threadpacket --url ${ORIGIN}/mcp`);
    for (const host of ["Claude Code", "Hermes", "Claude", "Codex", "ChatGPT"]) {
      expect(html).toContain(`<span class="tab-name">${host}</span>`);
    }
    const tags = [...html.matchAll(/<span class="badge" title="([^"]+)"><span class="dot [a-z]+" aria-hidden="true"><\/span>([^<]+)<\/span>/g)].map((m) => [m[2], m[1]]);
    expect(tags).toEqual(Array(5).fill(["Tested", "Tested: sign-in and sending worked with Threadpacket."]));
    expect(html).toContain("and ask Claude to attach it by name");
    expect(html).not.toMatch(/role="tab"[^>]*>(?:(?!<\/button>).)*class="dot/s);
    expect(html.match(/<span class="tab-logo [a-z-]+" aria-hidden="true">/g)?.length).toBe(5);
    expect(html).toContain('<span class="tab-logo hermes" aria-hidden="true"></span>');
    expect(html).toMatch(/\.tab-logo\.hermes \{[^}]*mask:url\("data:image\/png;base64,/);
    expect(html).toContain(`<p class="warn-box">To attach files, add <code>${new URL(ORIGIN).host}</code> to the allowed domains`);
    expect(html).toContain("for 10 minutes");
    expect(html).not.toContain("—");
  });

  it("each assistant's visible steps end with the first packet to ask for; notes, plan limits and sources fold into details", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/connect`)).text();
    const panels = html.split('<section class="host" ').slice(1).map((p) => p.slice(0, p.indexOf("</section>")));
    expect(panels.map((p) => /^id="panel-([a-z-]+)"/.exec(p)?.[1])).toEqual(["claude-code", "hermes", "claude", "codex", "chatgpt"]);
    for (const p of panels) {
      const name = /<h3 class="host-name">([^<]+)<\/h3>/.exec(p)![1]!;
      const [steps, folded] = [p.slice(p.indexOf('<ol class="steps">'), p.indexOf("</ol>")), p.slice(p.indexOf("<details"))];
      expect(p.indexOf('<ol class="steps">'), name).toBeGreaterThan(-1);
      expect(p.indexOf("</ol>"), name).toBeLessThan(p.indexOf("<details"));
      const last = steps.slice(steps.lastIndexOf("<li"));
      expect(last, name).toContain(`<li class="first-packet"><p>Ask ${name}:</p>`);
      expect(last, name).toContain("“Send myself a packet.”");
      expect(last, name).toContain('data-copy="Send myself a packet."');
      expect(steps.match(/<li class="first-packet">/g), name).toHaveLength(1);
      expect(steps, name).not.toMatch(/warn-box|class="note"|class="status"/);
      expect(folded, name).toContain('<p class="status">');
    }
    const panel = (id: string) => panels.find((p) => p.startsWith(`id="panel-${id}"`))!;
    const folded = (id: string) => panel(id).slice(panel(id).indexOf("<details"));
    expect(folded("claude")).toContain("<summary>Notes &amp; source</summary>");
    expect(folded("claude")).toContain('<p class="warn-box">To attach files');
    expect(folded("claude")).toContain("On Team or Enterprise plans");
    expect(folded("chatgpt")).toContain("developer mode enabled");
    expect(folded("hermes")).toContain("On a headless gateway");
    expect(folded("codex")).toContain("<summary>Connection details &amp; source</summary>");
    // Settings a step depends on stay in the visible steps.
    expect(panel("hermes").slice(0, panel("hermes").indexOf("</ol>"))).toContain("<code>trust: untrusted</code>");
    expect(panel("codex").slice(0, panel("codex").indexOf('<ol class="steps">'))).toContain('<p class="host-intro">');

    // The prompts after the first packet follow the setup window; without scripts the empty tab rail is not shown.
    expect(html.indexOf('<h2 class="after-title" id="after-title">After your first packet</h2>')).toBeGreaterThan(html.lastIndexOf('<section class="host" '));
    expect(html).toContain("html:not(.js) & .rail { display:none; }");
  });

  it("Claude's first step is an Add to Claude button that opens Claude's connector form prefilled, with the manual route under it", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/connect`)).text();
    const link = `https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=Threadpacket&amp;connectorUrl=${encodeURIComponent(`${ORIGIN}/mcp`)}`;
    expect(html).toContain(
      `<li><a class="btn step-button" href="${link}" target="_blank" rel="noopener">Add to Claude ↗</a><p class="step-hint">Opens Claude with Threadpacket prefilled.</p><p class="step-alt">Or add it by hand: <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">Customize &gt; Connectors</a> &gt; <strong>+ Add</strong> &gt; <strong>Add custom connector</strong>.</p></li>`,
    );
    expect(html.match(/class="btn step-button"/g)).toHaveLength(1);
    expect(html).not.toMatch(/one-click|one click/i);

    const md = await (await SELF.fetch(`${ORIGIN}/connect.md`)).text();
    expect(md).toContain(`1. [Add to Claude](${link.replace(/&amp;/g, "&")}): Opens Claude with Threadpacket prefilled. Or add it by hand:`);
    expect(md).not.toContain("Shortcut:");
  });

  it("on the hosted service, signing in leads with Create a team, and the setup note links to creating one now", async () => {
    const hosted = await (await home("/connect")).text();
    expect(hosted).toContain("Select <strong>Connect</strong>, choose <strong>Create a team</strong> if you&#39;re new, or sign in with your username and access code, and approve access.");
    expect(hosted).toContain("Choose <strong>Create a team</strong> if you&#39;re new, or sign in with your username and access code, and approve access.");
    expect(hosted).toContain('<p class="setup-note"><strong>New to Threadpacket? Create your team when you sign in.</strong> No email or personal details needed. <a href="/join">Or create it now →</a></p>');
    expect(hosted).not.toContain('class="btn" href="/join"');

    const own = await (await SELF.fetch(`${ORIGIN}/connect`)).text();
    expect(own).toContain("Select <strong>Connect</strong>, sign in with your username and access code and approve access.");
    expect(own).not.toContain("Create a team");
    expect(own).toContain('<p class="setup-note"><strong>Have your username and access code ready.</strong> <a href="/login">Sign in →</a></p>');
  });

  it("allows only its own nonce script on /connect", async () => {
    const res = await SELF.fetch(`${ORIGIN}/connect`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toBe(`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(2);
    for (const tag of scripts) expect(tag).toBe(`<script nonce="${nonce}">`);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("serves its fonts from this Worker, and the page names only fonts that exist", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`);
    expect(res.headers.get("content-security-policy")).toContain("font-src 'self'");
    const html = await res.text();
    const named = [...new Set([...html.matchAll(/\/fonts\/([a-z0-9-]+\.woff2)/g)].map((m) => m[1]))];
    expect(named.sort()).toEqual([...FONT_FILES].sort());
    for (const file of FONT_FILES) {
      const font = await SELF.fetch(`${ORIGIN}/fonts/${file}`);
      expect(font.status, file).toBe(200);
      expect(new Uint8Array(await font.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("wOF2"));
    }
    expect(html).not.toMatch(/https:\/\/fonts\.|googleapis/);
  });

  it("a signed-in browser's public pages lead to Dashboard, not Sign in, and no shared cache keeps either version", async () => {
    const cookie = `__Host-threadpacket-session=${"s".repeat(43)}`;
    for (const path of ["/", "/privacy", "/terms", "/about", "/contact"]) {
      const out = await home(path);
      expect(out.headers.get("cache-control"), path).toBe("private, no-cache");
      expect(await out.text(), path).toContain('href="/login">Sign in</a>');
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), control, createExecutionContext());
      const html = await res.text();
      expect(html, path).not.toContain(">Sign in</a>");
      expect(html, path).toContain('href="/packets">');
    }
    const signedIn = await (await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } }), control, createExecutionContext())).text();
    expect(signedIn).toContain('<a class="site-button primary" href="/packets">Dashboard</a>');
    expect(signedIn).toContain('<a class="site-button primary" href="/packets">Dashboard <span aria-hidden="true">→</span></a>');
    const priv = await (await SELF.fetch(`${ORIGIN}/privacy`, { headers: { cookie } })).text();
    expect(priv).not.toContain(">Sign in</a>");
    expect(priv).toContain('href="/packets">Dashboard</a>');
    for (const path of ["/b", "/admin", "/assets"]) expect((await home(path)).status, path).toBe(404);
  });

  it("the sign-in page uses the same fonts and light/dark palette", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/authorize`)).text();
    expect(html).toContain("/fonts/ibm-plex-sans-latin-400-normal.woff2");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("the Courier Hybrid homepage presents the live packet workspace and CSS-switched self-host tab with zero scripts", async () => {
    const connectHtml = await (await SELF.fetch(`${ORIGIN}/connect`)).text();
    expect(connectHtml).not.toContain('<a href="/">Home</a>');

    const res = await home();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("media-src 'self'");
    expect(csp).not.toContain("script-src");

    const html = await res.text();
    expect(html).toContain('<h1 id="hero-title">A mailroom for AI agents.</h1>');
    expect(html).toContain("Another person's agent picks it up and keeps working. Works with Claude, ChatGPT, Codex and Hermes.");
    expect(html).toContain("No email · No phone number · Auto-deleted after 7 days by default (30 days max)");
    expect(html).toContain("<dt>Short-lived, no AI</dt>");
    expect(html).toContain("Packets are auto-deleted after 7 days by default (30 days max).");
    expect(html).toContain("<span>EXPIRES IN 7D</span>");
    expect(html).not.toMatch(/auto-delete in|auto-deletes in|Gone in/i);
    expect(html).toContain("No email, no phone");
    expect(html).toContain("Packet // joe (Claude) → anna (ChatGPT)");
    expect(html).toContain("Car insurance renewal");
    expect(html).toContain("“Continue the packet from joe.”");
    expect(html).toContain("renewal-offer.pdf");
    expect(html).toContain('<a class="site-button primary" href="/connect">Send your first packet <span aria-hidden="true">→</span></a>');
    expect(html).toContain('<a class="site-button primary" href="/connect">Get started</a>');
    expect(html).toContain(`class="deploy-button" href="${DEPLOY_PATH}"`);
    expect(html).toContain('<img src="/img/deploy-to-cloudflare.svg" width="184" height="39" alt="Deploy to Cloudflare">');
    expect(html).toContain("THREADPACKET_SETUP_CODE");
    expect(html).toContain("npm run setup -- --members=tim,tom");
    expect(html.match(/href="\/deploy"/g)).toHaveLength(1);
    expect(html).toContain('<a class="nav-link nav-secondary" href="/login">Sign in</a>');
    expect(html).toContain('href="/llms.txt"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(`href="${GITHUB_URL}"`);
    expect(html).not.toContain("noindex");
    expect(html).not.toContain("—");
    expect(html).toBe(await (await home("/use-cases")).text());
    expect(html).toContain('src="/demo/threadpacket-demo.mp4"');
    expect(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")).not.toContain("<script");

    const vid = await SELF.fetch(`${ORIGIN}/demo/threadpacket-demo.mp4`);
    expect(vid.status).toBe(200);
    expect(new Uint8Array(await vid.arrayBuffer()).slice(4, 8)).toEqual(new TextEncoder().encode("ftyp"));
  });

  it("hides Connect on inactive instances and offers setup or CLI installation guidance", async () => {
    await env.DB.prepare("DELETE FROM admin_members").run();

    const homeHtml = await (await home()).text();
    expect(homeHtml).not.toContain('href="/connect"');
    expect(homeHtml).toContain(`href="${DEPLOY_PATH}"`);
    expect(homeHtml).toContain(`href="${GITHUB_URL}"`);
    expect(homeHtml).toContain('href="/console/setup"');

    const connectHtml = await (await SELF.fetch(`${ORIGIN}/connect`)).text();
    expect(connectHtml).not.toContain('href="/connect"');
    expect(connectHtml).not.toContain(`data-copy="${ORIGIN}/mcp"`);
    expect(connectHtml).not.toContain('role="tablist"');
    expect(connectHtml).toContain('href="/console/setup">Set up this server');
    expect(connectHtml).toContain(`href="${INSTALL_URL}"`);
    expect(connectHtml).not.toContain(`href="${DEPLOY_PATH}"`);
    expect(connectHtml).toContain(`href="${GITHUB_URL}"`);
  });
});
