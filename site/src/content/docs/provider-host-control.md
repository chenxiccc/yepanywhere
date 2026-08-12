---
title: Headless provider control
description: Run Yep Anywhere's experimental Linux provider layer without the web UI, or reach it through an authenticated server adapter.
---

Yep Anywhere can keep the live provider relationship outside its replaceable
web server. One worker owns the provider adapter, child process, queue,
approvals, and event stream for a session. A local tool can submit one bounded
turn to that worker without starting a second provider process or taking over
the web server's controller role.

This is an experimental source-checkout feature. It is useful for local agent
tools and for development workflows that reload the Yep Anywhere server while
provider work continues.

## Availability

Provider-host control currently requires Linux and a source checkout. It starts
automatically under non-watch `pnpm dev`, or independently in a foreground
terminal:

```bash
pnpm provider-host
```

The foreground terminal owns the host lifetime. Ending it shuts down and
verifies cleanup of the workers and provider processes it launched.

macOS, Windows, `pnpm dev --watch`, direct server launches, and an unavailable
or incompatible host keep the ordinary in-server provider path. They do not
silently create a second provider owner, and headless control reports
unavailable.

## Stable local boundary

The host publishes an owner-only descriptor and token under the selected Linux
runtime directory. The descriptor names protocol version 2, a mode-0600 Unix
socket, owner process identity, and source/build identity. The host never binds
this control surface to TCP, and per-worker sockets remain private.

The newline-delimited local protocol supports status, runtime inventory,
launch-or-claim, one streamed session turn, receipt lookup, and interruption.
A turn is addressed by provider harness plus durable provider session id; an
optional canonical YA session id adds an ownership cross-check. A
caller-generated submission id makes reconnect replay safe and rejects reuse
with different content.

The stream distinguishes acceptance, ordered provider events, approvals,
terminal receipts, and errors. Once accepted, a caller must inspect or
interrupt that submission rather than falling back to another transport.
Timeout, output, replay, idle teardown, and recovery are bounded. See the
[versioned provider-host protocol](https://github.com/kzahel/yepanywhere/blob/main/topics/provider-host-api.md)
for request shapes and exact outcomes.

## Authenticated server adapter

A compatible Yep Anywhere server advertises `provider-host-control` only while
it is registered with the host. Its ordinary authenticated API exposes status,
inventory, streamed turns, receipts, and interruption under
`/api/provider-host` for direct and relay-connected clients.

The HTTP adapter can address only an incumbent worker. It cannot launch a
provider runtime, expose the local socket, acknowledge the server's provider
replay stream, or answer approvals on its own. If the capability is absent, a
client should hide this feature and make no provider-host request.
