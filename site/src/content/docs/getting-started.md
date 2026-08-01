---
title: Getting started
description: Choose how to run Yep Anywhere, open the local dashboard, and start or resume your first agent session.
---

Yep Anywhere runs coding agents on a computer you control and gives you a
responsive browser interface for supervising them. The browser can disconnect;
the server keeps active agent processes and session history on the host.

## Before you install

You need a supported computer with at least one agent installed:

- **Claude Code** for the primary Claude workflow.
- **Codex CLI** for the primary Codex workflow.
- An experimental provider only if you are comfortable with a narrower feature
  set.

The desktop apps bundle Yep Anywhere itself, but they do not install or sign in
to Claude Code or Codex for you.

## Choose an installation

| Installation | Best for | Status |
| --- | --- | --- |
| [Desktop app](/docs/desktop-apps) | A one-click app, tray controls, and bundled updates on macOS or Windows | Experimental |
| [npm install](/docs/install-npm) | Linux, servers, terminals, and full configuration control | Available |
| Source checkout | Contributors and people who want to follow `main` | Available, development-oriented |

There is no published Android app yet. Use the mobile browser interface from
your phone; it is the normal mobile experience and does not require an app-store
install.

## Open Yep Anywhere

The npm installation starts with:

```bash
npm i -g yepanywhere
yepanywhere
```

Then open `http://localhost:3400` on the host computer. A desktop installation
opens its bundled dashboard for you.

Yep Anywhere detects installed providers. If Claude Code or Codex is missing,
install and authenticate it using that provider's official setup, then restart
or recheck Yep Anywhere.

## Start or resume a session

Use **New session** to choose a project, provider, model, and permission mode.
You can also open a session that already exists in the CLI or a compatible
first-party tool. Yep Anywhere uses its own stable session URL while retaining
the provider's native resume identity behind the scenes.

The ordinary workflow is intentionally familiar:

1. Send a prompt.
2. Watch the response and tool activity stream.
3. Approve or reject actions that require permission.
4. Queue a follow-up or steer a compatible provider when needed.
5. Leave the browser; return later without losing the server-owned session.

Continue with [Sessions and approvals](/docs/sessions-and-approvals), or set up
[remote access](/docs/remote-access) before leaving the host computer.

## Phone access

For a quick same-network check, open the server from a trusted LAN or private
network. For access over the internet without port forwarding, configure the
public relay in **Settings → Remote Access**, then use
[yepanywhere.com/remote](https://yepanywhere.com/remote).

Do not expose an unauthenticated local server directly to the public internet.
