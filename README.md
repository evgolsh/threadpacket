# Threadpacket

[![Threadpacket MCP connector](https://glama.ai/mcp/connectors/io.github.evgolsh/threadpacket/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.evgolsh/threadpacket)
[![evgolsh/threadpacket MCP server](https://glama.ai/mcp/servers/evgolsh/threadpacket/badges/score.svg)](https://glama.ai/mcp/servers/evgolsh/threadpacket)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Threadpacket sends ephemeral packets from one AI agent or assistant to another: the agent's brief of the work so far, with the original files (any type, up to 25 MiB).

Use it to move work across your own machines and clients (for example Hermes on a Mac mini to Claude Code, Codex, or Cursor on a laptop), or hand a thread and its PDFs to a teammate or partner using Claude or ChatGPT. No pasting summaries between chats, no re-uploading files, and no email or phone number to sign up.

Threadpacket is a remote Streamable HTTP MCP server with built-in OAuth 2.1 (dynamic client registration, Client ID Metadata Documents, and PKCE). It makes no model calls, needs no API keys, and deletes packets automatically when they expire.

Free hosted service at **[threadpacket.com](https://threadpacket.com)**, or MIT-licensed self-hosting on your own Cloudflare free-tier account.
[Watch the 28-second hosted walkthrough](docs/threadpacket-hosted-demo.mp4).

## Quick start (hosted)

Connect any supported MCP client to `https://threadpacket.com/mcp`:

| Client | Setup |
|---|---|
| **Hermes Agent** | `hermes plugins install threadpacket`, add the OAuth entry with `trust: untrusted` in `config.yaml`, then run `hermes mcp login threadpacket` |
| **Claude** | [Add custom connector](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Threadpacket&connectorUrl=https%3A%2F%2Fthreadpacket.com%2Fmcp) |
| **Claude Code / Codex** | Install the [plugin](plugin/README.md#install) (adds the brief-writing skill) or connect `https://threadpacket.com/mcp` |
| **Cursor** | Add `https://threadpacket.com/mcp` as a remote MCP server and sign in with OAuth |
| **ChatGPT & others** | Add `https://threadpacket.com/mcp` (see [Assistant setup](https://threadpacket.com/connect)) |

1. **Create a team.** On the sign-in page, choose **Create a team**, pick a username (team name is optional), and save the generated access code once. The same username and access code work across every machine and client you connect.
2. **Try it on your own.** Say `"Send myself a packet."` in one agent, then `"Continue my packet."` in another.
3. **Invite a teammate or partner (optional).** Say `"Invite anna to Threadpacket."` and share the one-time link. Then `"Send a packet to anna with the two PDFs."` and she says `"Continue the packet from joe."`

Hosted limits: free, up to 10 people per team, up to 25 MiB per file (10 files per packet, 256 MiB live per team), deleted after 7 days by default (30 days max). See [Privacy](https://threadpacket.com/privacy) and [llms.txt](https://threadpacket.com/llms.txt).

## How it works

When you ask your agent to send a packet, it writes a structured brief (purpose, decisions, constraints, next step, references, open questions) and attaches the files you choose. Threadpacket stores the brief and original bytes verbatim with a SHA-256 checksum per file. Packets can be addressed to yourself, to one teammate's username, or to `team`.

| Tool | Purpose |
|---|---|
| `threadpacket_send` | Publish a packet (brief, optional `to`, and attachments by id or unsent filename). Idempotent per `idempotency_key`. |
| `threadpacket_inbox` | List unexpired packets newest first (with pickup status per recipient) plus your unsent uploaded files. |
| `threadpacket_read` | Read a packet's brief and attachment list, or fetch an attachment (inline text/image, or a 10-minute verified download URL). The recipient's first read records pickup with assistant name and time. Without `packet_id`, opens one of your own unsent files. |
| `threadpacket_revoke` | Hide a packet and stop further reads and downloads. |
| `threadpacket_upload_url` | Mint a single-use 15-minute `PUT` upload URL for a local file. |
| `threadpacket_invite` | Team admin: add a teammate and generate a one-time invitation link valid for 7 days. |

Any file type is accepted (PDF, Word, Excel, images, ZIP, text) up to 25 MiB per file and 10 files per packet. Hosted packets expire after 7 days by default (1 hour to 30 days); private-server packets expire after 30 days by default (1 hour to 90 days).

## Web UI (`/packets`)

Every member can sign in at `/login` with their username and access code (no email, up to five accounts per browser, 30-day rolling session):

- **Inbox and pickup status:** View incoming and sent packets, see when each recipient picked up a packet (and in which assistant) or opened it in the browser, preview PDFs/images/text inline, download original files, or revoke a sent packet.
- **Upload from phone or browser:** Upload files on `/packets` so any connected agent can attach them by filename (`"Send a packet to anna with lease.pdf"`) or read them directly (`"Read lease.pdf from Threadpacket"`). Unsent files are visible only to the uploader and auto-delete after 7 days.
- **Team management:** Team admins manage members, invitations, and connected assistants from the same sidebar. See the [console guide](docs/CONSOLE.md) for details.

## Self-host on Cloudflare

Install once for a private server on your own Cloudflare account (Workers, D1, and KV; free plan, no card required: 100,000 requests/day, 1,000 new files/day, 1 GB stored). Your briefs and files stay on your account, and teammates only need to sign in. [Watch the 29-second self-host walkthrough](https://threadpacket.com/demo/threadpacket-demo.mp4).

### Option 1: Deploy from your browser

Requires a **Cloudflare account** and a **GitHub or GitLab account**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://threadpacket.com/deploy)

Set `THREADPACKET_SETUP_CODE` to a secret of 12 or more characters. After deployment finishes, open `/console/setup` on your Worker URL and enter it with your admin username. See [Deploy button details](docs/DEPLOY.md#from-your-browser).

### Option 2: Ask a coding agent

Give Claude Code, Codex, Hermes, or any coding agent with shell access this prompt (with your own usernames):

> Deploy https://github.com/evgolsh/threadpacket to my Cloudflare account. Follow llms-install.md. My username is tim; add tom as a teammate. Ask me to approve the Cloudflare login, then help me connect my assistants.

No GitHub account required. The agent follows [llms-install.md](llms-install.md).

### Option 3: Terminal setup

Requires **Git**, **Node.js 22+**, and a **Cloudflare account** (no GitHub account required):

```sh
git clone https://github.com/evgolsh/threadpacket.git
cd threadpacket
npm install
npm run setup -- --members=tim,tom
```

Put your own username first (`tim,tom`). Setup creates the D1 database and KV namespace, deploys the Worker, makes the first user an admin, and prints your `/connect`, `/console`, and access codes.

- Usernames: 3 to 63 lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit (`team` and `all` are reserved).
- Always pass `--members=` (omitting it seeds placeholder `owner` and `teammate` accounts).
- If your Cloudflare account already has a Worker named `threadpacket`, review [existing deployments and reruns](docs/DEPLOY.md#existing-deployments-and-reruns) first.
- Fresh Cloudflare accounts may prompt you to register a `workers.dev` subdomain; register it and re-run setup.

### After deploying

1. **Sign in to `/console`:** Browser deploys finish at `/console/setup` (which prints your admin access code once); terminal deploys print the `/console` URL and access codes directly. Store access codes in a password manager.
2. **Connect clients:** Open `/connect` on your server and point clients to `https://<your-worker>/mcp` (for example `https://threadpacket.acme.workers.dev/mcp`).
3. **Add teammates:** Say `"Invite tom to Threadpacket."` in a connected agent, or add usernames in **Members**. Teammates need no Cloudflare or GitHub account.
4. **Update later:** From the same clone (which holds your gitignored `wrangler.local.jsonc`), run `git pull --ff-only && npm install && npm run deploy`. Migrations run automatically without touching members. See [updates and recovery](docs/DEPLOY.md#updates-and-recovery).

## Security

- **Built-in OAuth 2.1:** The Worker issues ES256 access tokens (`iss: PUBLIC_URL`, `aud: PUBLIC_URL/mcp`, 8 h lifetime), 10-minute authorization codes, and 30-day rotating refresh tokens. Clients register via RFC 7591 or HTTPS Client ID Metadata Documents with redirect validation and PKCE S256. Member access codes are PBKDF2-hashed; no third-party IdP.
- **Scoped packet and file access:** Packets are visible only to the sender, named recipient, or team members (for `to: "team"`). Everyone else receives "not found". Only the sender can revoke a team packet. File download URLs last 10 minutes and re-verify packet access on every fetch.
- **Web sessions and CSRF:** `/login` sets `__Host-threadpacket-session` (`HttpOnly`, `SameSite=Strict`), stored in D1 as hashes only. Admin routes verify the admin grant on every request, and forms validate `Origin` plus a per-session CSRF token.
- **One-time invites and revocation:** Invitation links expire after 7 days and require a button click to claim so link previews cannot burn them. Resetting a code or removing a member immediately revokes their active tokens and sessions.
- **Server-side file imports:** Remote file imports (such as ChatGPT attachments) refuse redirects, bound size, never log signed URLs, and can be restricted via `IMPORT_HOST_ALLOWLIST`.
- **Rate limiting:** Sign-in attempts are limited per address. The hosted service limits each signed-in person to 120 requests a minute on `/mcp` and `/v1`, and a private server does the same once you bind `MEMBER_LIMITER` (see [Operations](docs/DEPLOY.md#operations)). `/mcp` has no per-IP limit, because claude.ai and ChatGPT call it from shared servers.

## Update check

Private installs check `threadpacket.com` once a day for newer releases and display update status on the Ops page. The check sends only a random instance ID, the Worker version, and coarse size buckets (members: `0`, `1`, `2-5`, `6+`; 30-day packets: `0`, `1-9`, `10-49`, `50+`). Disable it with `THREADPACKET_UPDATE_CHECK=off`.

## Docs

- [Deploy and operations](docs/DEPLOY.md): setup safety, Deploy button, environment variables, rate limits
- [Console](docs/CONSOLE.md): admin pages, member management, analytics, local run
- [Development](docs/DEVELOPMENT.md): running tests and local development
- [Install guide for coding agents](llms-install.md): step-by-step agent deployment guide
- [Plugin package](plugin/): Claude Code, Codex, and Hermes plugin setup
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md)
- Machine-readable endpoints: [llms.txt](https://threadpacket.com/llms.txt), [MCP server card](https://threadpacket.com/.well-known/mcp/server-card.json), [agent skills index](https://threadpacket.com/.well-known/agent-skills/index.json)
