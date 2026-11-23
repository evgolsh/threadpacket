# Development

Requirements: Node 22+ and npm. No Cloudflare account is needed for tests or local runs.

```sh
npm install
npm test          # vitest inside workerd, with local D1, KV and R2
npm run typecheck
```

## Local server

```sh
cp .dev.vars.local.example .dev.vars   # .dev.vars.example lists the deployed Worker's secrets instead
npm run db:migrate:local
npm run dev        # http://localhost:8787
```

With `THREADPACKET_ENV=dev`, the tokens in `DEV_TOKENS` are accepted as bearer tokens on requests to
localhost. This exists only for the local server and the MCP Inspector; production ignores `DEV_TOKENS`.

```sh
curl -s http://localhost:8787/mcp -H 'authorization: Bearer dev-alice' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Layout

- `src/env.ts`: bindings and limits.
- `src/auth/`: the OAuth 2.1 server (`builtin.ts`: registration, sign-in page, token exchange, signing key), bearer verification, the 401 challenge, resource metadata.
- `src/domain/service.ts`: packets, idempotency, attachments, imports, tickets, cleanup. No HTTP or MCP here.
- `src/store/`: the `Repository` and `BlobStore` contracts, with the D1, KV and R2 implementations. `blobStore(env)` picks the adapter `FILE_STORE` names (kv or r2); unset, R2 when a bucket is bound, else KV. A new store is one adapter and one entry in that table.
- `src/http/routes.ts`: upload and download endpoints. `src/http/connect.ts`: the Connect page. `src/http/packets.ts` and `src/http/packets-page.ts`: `/packets` and packet detail pages.
- `src/http/agents.ts`: what agents read: `/llms.txt`, the MCP server card, the `/.well-known` catalogs and agent skill, Markdown versions of the public pages, `robots.txt`, the sitemap, `/privacy` and `/about`. `src/http/meta.ts`: the head tags and Link headers that point to them.
- `src/domain/teams.ts` and `src/domain/invites.ts`: creating a team on the hosted service (from `/join` or the sign-in page) and invitation links (`threadpacket_invite`, `/invite/<token>`, `src/http/invite.ts`).
- `src/console/`: the operators' console at `/console` (`docs/CONSOLE.md`). `src/store/events.ts` and `src/store/telemetry.ts`: what it reads (events, revocations); `src/cleanup.ts`: the hourly cleanup.
- `src/mcp/server.ts`: the six tools and the server instructions.
- `migrations/`: the D1 schema, one file; a schema change is a new numbered file after it.
- `plugin/`: the plugin package for Claude, ChatGPT and Codex (see [Plugin package](#plugin-package)).
- `test/`: the suite. `test/fixtures/test-private-jwk.json` is a test-only signing key: the tests pass it as
  `OAUTH_SIGNING_JWK`, so `test/helpers.ts` can mint the same tokens the Worker issues.

Regenerate the test key if wanted:

```sh
node --input-type=module -e '
import { generateKeyPair, exportJWK } from "jose"; import { writeFileSync } from "node:fs";
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const priv = await exportJWK(privateKey);
Object.assign(priv, { kid: "test-key-1", alg: "ES256" });
writeFileSync("test/fixtures/test-private-jwk.json", JSON.stringify(priv, null, 2));'
```

## Preview image and icon

`npm run images` renders `docs/og.png` (1200x630, the link preview), `docs/icon.png` (512x512, for the MCP server card and directory listings) and the site icons (`docs/favicon.ico`, `docs/favicon.svg`, `docs/apple-touch-icon.png`) with headless Chrome. `npm run assets` copies them to `public/`. Re-render after changing the headline or the brand icon, and copy the new `docs/icon.png` to `plugin/assets/icon.png`.

## Demo video

`npm run video` renders `docs/threadpacket-demo.mp4`, the walkthrough on the homepage, from [`scripts/demo-video/render.mjs`](../scripts/demo-video/render.mjs). It needs Google Chrome and ffmpeg (`brew install ffmpeg` on macOS), and takes about a minute and a half. The scene is one HTML page that uses the site's fonts, colours and icons; the times of each step are in the `T` table at the top of the script.

To check one moment without rendering the whole video, `npm run video -- --still=18` writes the frame at 18 seconds to a PNG and prints its path. If the length changes, update `DURATION` in the script, the "Demo, 29 seconds" label in `src/http/use-cases.ts` and the demo link in `README.md`.

## Plugin package

`plugin/` holds the multi-host plugin package. Its `README.md` describes installation and usage.

| File | Read by |
|---|---|
| `plugin.json`, `mcp.json` (`type: streamable-http`) | ChatGPT and Codex (Agent Plugins format). |
| `.claude-plugin/plugin.json`, `.mcp.json` (`type: http`) | Claude Code and Claude desktop/web apps. |
| `.codex-plugin/plugin.json` | Legacy Codex CLI compatibility. |
| `.cursor-plugin/plugin.json` (repository root), root `mcp.json` | Cursor Marketplace. The logo is `plugin/assets/icon.svg`. Skills are `plugin/skills`. The server is `https://threadpacket.com/mcp`. |
| `skills/threadpacket/SKILL.md`, `assets/`, `LICENSE` | Shared skill instructions, icons (`assets/icon.svg`, `assets/icon.png` at 512 px), and licence. |

Checks:

```sh
claude plugin validate ./plugin
claude --plugin-dir ./plugin mcp list
npm run pack:plugin                             # dist/threadpacket-plugin-<version>.zip
```

A package change raises the version in every manifest together (`package.json`, `package-lock.json`,
`server.json`, the three plugin manifests, `.cursor-plugin/plugin.json`, `gemini-extension.json`):
Codex caches an installed plugin by version. `test/manifests.test.ts` fails when they differ.

### Install from this repository

The repository root acts as a plugin marketplace for both hosts: `.claude-plugin/marketplace.json` (Claude Code) and
`.agents/plugins/marketplace.json` (Codex), each listing `./plugin`.
The install commands are in [plugin/README.md](../plugin/README.md#install).

### Install in Codex (the tested route)

Tested with Codex Desktop 0.164.0 on macOS.
A local marketplace is a folder with `.agents/plugins/marketplace.json`. The tested one was the home
folder, with this file (`path` is relative to that folder):

```json
{
  "name": "acme-local",
  "plugins": [
    {
      "name": "threadpacket",
      "source": { "source": "local", "path": "./dev/threadpacket/plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

```sh
codex plugin marketplace add ~           # the folder that holds .agents/plugins/marketplace.json
codex plugin add threadpacket@acme-local # <plugin name>@<marketplace name>
```

Then start a new Codex chat, sign in with your username and access code, and check that the six
tools appear. An already-running chat may need to be reopened before it loads a new plugin.

### Codex compatibility

Keep the MCP server entry to the standard transport and URL fields. Codex Desktop 0.164.0
rejects a nested `mcpServers.threadpacket.extensions` field and omits the entire server, even when
the plugin appears installed and its skill loads. Authentication
comes from the server's OAuth challenge and discovery metadata; removing the client
extension does not disable OAuth.
