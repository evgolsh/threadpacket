# Threadpacket

Send your work to someone else's AI assistant, with your notes and the original files. Say "send a packet to anna" and your assistant writes a brief (purpose, decisions and their reasons, constraints, next step, references, open questions), attaches the files you choose, and sends it to anna's Threadpacket inbox. In her own assistant (Claude, ChatGPT, Cursor, Codex, Claude Code or Hermes) she says "continue the packet from joe" and carries on with the original files.

This plugin adds the Threadpacket skill, which tells the assistant how to write a brief and pick up a packet, and connects the Threadpacket server at `https://threadpacket.com/mcp`.

## Install

Cursor: after the plugin is on the Marketplace, open **Customize**, find **Threadpacket**, and install it. It connects to `https://threadpacket.com/mcp` and adds the skill that writes the brief. Sign in with your username and access code when the first tool call opens the browser. To try a local build, copy this repository to `~/.cursor/plugins/local/threadpacket` (a real directory, not a symlink to the clone) and run **Developer: Reload Window**. See the [Cursor section of the README](../README.md#cursor).

Claude Code 2.1.275 or later:

```
/plugin install threadpacket --marketplace evgolsh/threadpacket
```

On older versions, run `/plugin marketplace add evgolsh/threadpacket`, then `/plugin install threadpacket@threadpacket`. Then run `/mcp`, choose the Threadpacket server and select **Authenticate**.

Codex CLI:

```sh
codex plugin marketplace add evgolsh/threadpacket
codex plugin add threadpacket@threadpacket
codex mcp login threadpacket
```

For Claude and ChatGPT, follow [Assistant setup](https://threadpacket.com/connect).

Hermes: install Threadpacket from the plugin catalog, then sign in once. Agent Plugins packages cannot ask Hermes for OAuth, so the sign-in uses a normal Hermes server entry with the same name. Add this to your profile's `config.yaml` (replace any existing `threadpacket` entry as a whole):

```yaml
mcp_servers:
  threadpacket:
    url: "https://threadpacket.com/mcp"
    auth: oauth
    trust: untrusted
```

Then run `hermes mcp login threadpacket`, sign in with your username and access code, approve access, and start a new session.

A `config.yaml` entry with the same name replaces the package's own server entry, including its `trust: untrusted` setting, so keep `trust: untrusted` in the entry above. If you add the server with `hermes mcp add threadpacket --url https://threadpacket.com/mcp --auth oauth` instead, add `trust: untrusted` to the entry that command creates. With it, Hermes asks you before each Threadpacket tool call that sends, revokes, invites or uploads, because these tools send files to other people, revoke packets and invite members, and refuses those calls in unattended runs such as cron. Reading your inbox and packets does not ask.

## What you need

A Threadpacket team. Create one at [threadpacket.com/join](https://threadpacket.com/join), or open the invitation link a teammate sent you. The first time a Threadpacket tool runs, your assistant opens a browser page where you sign in with your username and access code. A team has up to 10 people.

## Tools

- `threadpacket_send`: sends a packet (brief and files) to yourself, to one teammate or to the whole team.
- `threadpacket_inbox`: lists your packets, who picked them up and who has not yet, and your unsent files.
- `threadpacket_read`: reads a packet or one of its files. The sender then sees it was picked up, in which assistant and when.
- `threadpacket_upload_url`: gets a one-time upload address for a file on your computer.
- `threadpacket_revoke`: revokes a packet you sent. Content already read cannot be recalled.
- `threadpacket_invite`: makes an invitation link for a new teammate (team admins only).

## What it sends, and where

- The brief and the title go to threadpacket.com, with the files you chose. Nothing is sent until you ask to send a packet, or say yes when the assistant offers one.
- To attach a file from your computer, the assistant calls `threadpacket_upload_url`, checks that the upload address it gets back is on threadpacket.com, and uploads that one file with a fixed `curl` command (macOS, Linux) or `Invoke-WebRequest` command (Windows). The server returns only the address and the file's type, never a command to run.
- In Claude apps, attaching a file from the chat needs `threadpacket.com` in Settings > Capabilities > allowed domains. Without it the upload fails with a 403 error.
- Packets are kept 7 days by default and 30 days at most, then deleted. Files of any type, up to 25 MiB each and 10 per packet.
- Threadpacket stores what you send as you sent it and runs no AI on it. In Threadpacket, only you and the people you sent it to can open it. It is not end-to-end encrypted; the Privacy page says who can technically read it.

[Privacy](https://threadpacket.com/privacy) · [Terms](https://threadpacket.com/terms) · [Help](https://threadpacket.com/contact) · [Source](https://github.com/evgolsh/threadpacket) (MIT)

## Your own server

Threadpacket is open source. If your team runs its own Threadpacket server, change the URL in `.mcp.json` (Claude Code) and `mcp.json` (ChatGPT, Codex) to your server's `/mcp` address before you install. In Hermes, use that address as the `url` of the `config.yaml` entry above. The Cursor Marketplace plugin stays on `https://threadpacket.com/mcp`. For a private server in Cursor, add that server's `/mcp` address as your own MCP server.
