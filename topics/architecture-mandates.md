# Architecture Mandates

> YA's load-bearing architecture requirements must be explicit enough that
> future provider, transport, and client changes preserve bounded resource use,
> recoverability, and user-visible state correctness.

Topic: architecture-mandates

See also:

- [`session-catalog-observation.md`](session-catalog-observation.md)

## Resource Quiescence

An idle provider session with no active client tab must never create unbounded
or repeating server work. Closed tabs must release server subscriptions, file
watchers, poll timers, retry timers, client-owned heartbeats, and queued
catch-up work. A provider process may remain recoverable or queryable, but it
must not spin merely because a prior UI view existed.

The resource owner for every recurring server action must be explicit:

- client-owned watches and streams are reference-counted and torn down on
  disconnect;
- provider-owned processes stop polling once the provider is verified idle or
  terminated, unless a bounded recovery operation is currently running;
- global background jobs have fixed cadence, bounded per-tick work, and no
  per-session loops created by stale client state;
- client retry/catch-up paths coalesce in-flight requests and avoid turning
  one provider event into repeated REST reads.

## Continuous Observation Without Corpus Polling

The server is the long-lived observer for install-wide summary state. Durable
compact indexes plus bounded restart reconciliation preserve that role across
brief outages; a client page request must not become the owner of a provider
corpus scan.

Global background work may continue without connected clients when it keeps a
bounded shared projection useful. One same-user process inventory, one provider
watcher/reconciliation owner, or one next-deadline scheduler is allowed. Its
cost must be bounded independently of stale session count, and changes must
target exact rows. A timer may not sweep or parse every old transcript merely
to prove nothing changed.

Client viewport, hover, and detail interest controls refresh priority and
permitted fidelity. Old offscreen rows may be explicitly stale until promoted;
live processes, provider/file events, and bounded reconciliation still keep the
global baseline moving toward fresh. Identical interest from many components,
tabs, or devices is unioned and joins one keyed asynchronous computation.

Expensive server computations use one in-flight owner per source version and
projection/fidelity key. Waiters share the result, stale completions cannot
publish over newer evidence, and one bounded failure/backoff policy replaces
per-caller retry herds.

## Review Checklist

- Every poll, retry, heartbeat, watch, and catch-up path has a teardown path.
- Closed WebSocket/EventSource subscriptions remove server-side subscribers
  and clear timers.
- Idle sessions do not schedule per-session server work without a live owner or
  a bounded recovery reason.
- Session-detail reads for incremental refreshes reuse cached parse state or
  have instrumentation proving the remaining work is bounded enough.
- Client-side reconnect and catch-up logic cannot create overlapping request
  storms against the same session.
- Multiple tabs/devices requesting the same catalog projection join one
  server-side computation; client-side dedupe is an optimization, not the only
  herd control.
- Periodic host/process reconciliation performs no unrelated provider
  transcript reads, and unchanged cold sessions receive no timer-driven parse.
