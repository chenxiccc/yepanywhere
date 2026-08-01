---
title: Remote access
description: Choose direct access, the free end-to-end encrypted public relay, or self-hosted infrastructure.
---

Yep Anywhere runs on your development machine. Remote access changes how a
browser reaches that server; it does not move provider processes or session
storage into a hosted account.

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

## Connection troubleshooting

Check these in order:

1. Confirm the Yep Anywhere server is running locally.
2. Open the local dashboard on the host.
3. Verify the username and exact remote URL.
4. Check **Settings → Remote Access** for relay status.
5. Look at the server log for reconnect or authentication errors.

Continue with [Troubleshooting](/docs/troubleshooting) for log locations and
safe issue-report evidence.
