---
title: Install from npm
description: Install Yep Anywhere from npm or source on macOS, Windows, or Linux and launch the local dashboard.
---

The npm installation is the established path for terminals, Linux machines,
remote servers, and setups that need environment-level configuration.

## Requirements

- Node.js 20.12 or newer.
- npm, or a source checkout with pnpm.
- Claude Code, Codex CLI, or another configured provider.

## Global npm install

```bash
npm i -g yepanywhere
yepanywhere
```

Open `http://localhost:3400` in a browser. Yep Anywhere detects installed
Claude Code and Codex applications and reads their existing compatible session
history.

## Install from source

Use a source checkout when contributing or deliberately following unreleased
work:

```bash
git clone https://github.com/kzahel/yepanywhere.git
cd yepanywhere
pnpm install
pnpm build
pnpm start
```

For local development with live client/server rebuilds, use `pnpm dev` instead
of the production build/start pair.

## Ports and profiles

The main server defaults to port `3400`. Related maintenance and development
ports are derived from the same `PORT` value:

```bash
PORT=4000 YEP_PROFILE=dev yepanywhere
```

A profile stores state in a separate data directory. Use profiles when a
development instance must not share settings and uploads with the normal
installation.

The default data directory is `~/.yep-anywhere/` on macOS and Linux and
`%USERPROFILE%\.yep-anywhere\` on Windows. Set `YEP_DATA_DIR` to use an
explicit location. `YEP_PROFILE=dev` uses the suffixed directory
`.yep-anywhere-dev` under the same user home directory.

## Provider setup

Authenticate providers using their official CLI. Yep Anywhere does not collect
provider credentials or intercept OAuth tokens. Provider-specific API keys and
experimental integrations may require explicit environment or Settings values;
see [Providers](/docs/providers).
