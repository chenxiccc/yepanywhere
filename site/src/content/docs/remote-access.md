---
title: Remote access
description: Choose direct access, the free end-to-end encrypted public relay, or self-hosted infrastructure.
---

Yep Anywhere runs on your development machine. Remote access changes how a
browser reaches that server; it does not move provider processes or session
storage into a hosted account.

## Any controller, any host

The controlling device does not have to be a phone. Use one computer to
supervise agents running on another, or reconnect from a laptop, Chromebook,
tablet, or phone. Any modern browser can be the control surface while the host
computer keeps the code, provider credentials, sessions, and agent processes.

Claude Remote Control and Codex Remote Control provide useful first-party
paths inside their respective products. Yep Anywhere is provider-neutral and
browser-first: the same interface supervises Claude Code and Codex across the
machines you control, without requiring a native controller app or a particular
controller operating system.

## Choose a connection method

| Method | Best for | Trade-off |
| --- | --- | --- |
| Direct LAN/private network | Trusted local networks or an existing Tailscale setup | You manage reachability |
| Public relay | Fast access from any browser without port forwarding | Connection metadata reaches the relay; authenticated application traffic is end-to-end encrypted |
| Self-hosted relay/reverse proxy | Operators who want full infrastructure control | More deployment and security responsibility |

## Public relay

In **Settings → Remote Access**, choose a username and a strong password, then
enable the relay. For a headless setup:

```bash
yepanywhere --setup-remote-access --username myserver --password "use-a-long-unique-password"
```

Connect at [yepanywhere.com/remote](https://yepanywhere.com/remote). The browser
and server authenticate with SRP and encrypt application messages before they
cross the relay. The relay sees connection metadata and encrypted traffic, not
the authenticated session contents or password.

Public read-only share links use a different trust boundary and must not be
described as equivalent to an authenticated end-to-end encrypted relay session.
See [Security and privacy](/docs/security-and-privacy).

## Direct access

For a trusted LAN or private network, open the server using the host's reachable
address and configured port. Tailscale is a common way to give the host and
phone a private address without exposing a public port.

Do not publish an unauthenticated local listener directly to the internet.
Terminate HTTPS and require authentication when using your own public reverse
proxy.

## Self-hosted infrastructure

You can run your own relay or place Yep Anywhere behind an HTTPS reverse proxy.
This is an operator workflow: you are responsible for certificates,
authentication, updates, origin restrictions, logs, and abuse controls.

The public [relay design](https://github.com/kzahel/yepanywhere/blob/main/docs/project/relay-design.md)
documents the protocol and deployment components for self-hosting.

## Why no native mobile app yet?

The responsive browser client already supports the complete Yep Anywhere
workflow on phones and tablets, including approvals, diffs, uploads, voice
input, notifications, session history, and new sessions. Shipping a native app
that only wraps this interface would add another installation and release path
without adding enough user value.

The Android app is in development as a real companion: more reliable
background notifications, deep links, trusted packaged client code, and a
multi-server inbox are the intended native advantages. It is not published
until those capabilities and the release path are ready. Use the browser client
today; no public APK or app-store listing is available.

## Connection troubleshooting

Check these in order:

1. Confirm the Yep Anywhere server is running locally.
2. Open the local dashboard on the host.
3. Verify the username and exact remote URL.
4. Check **Settings → Remote Access** for relay status.
5. Look at the server log for reconnect or authentication errors.

Continue with [Troubleshooting](/docs/troubleshooting) for log locations and
safe issue-report evidence.
