# Server-Side Settings

> Proposed contract for server-owned configuration: every client reads and
> writes one authoritative server state, while costly runtime features follow
> aggregate client-demand leases plus a configurable warm-retention period
> instead of the last browser to toggle a boolean.

Topic: server-side-settings

## Separate policy, demand, and runtime state

A server-side setting is durable operator policy for one YA server. It is
shared by every client connected to that server and survives browser and server
restarts. It is not a browser preference, even when a browser provides the UI
used to edit it.

Costly features need three separate kinds of state:

- **Server policy** says how long the supporting resource stays warm after use
  and reserves an admission check for an exceptional operator block. This is
  durable and server-wide. Admission defaults to allowed; the block is not the
  normal feature toggle or the ordinary cost-control mechanism.
- **Demand leases** say which clients currently need the feature. They are
  transient, generation-scoped, and aggregated by the server. They do not
  belong in settings storage.
- **Effective runtime state** is derived from policy, current demand, warm
  retention, resource limits, and circuit breakers. It is observable status,
  not another independently editable value.

This prevents two opposite failures: an abandoned browser cannot impose a
permanent server cost, and one client's write or disconnect cannot cancel a
feature that another client is actively using.

## Client opt-in controls demand

A novel costly feature defaults to **not requested** on each client. Enabling
the feature is a client preference. The client immediately sends a preparation
request and acquires a demand lease; it does not wait for the first search,
workbench visit, or other feature operation. The server can therefore build the
index, establish watchers, or perform catch-up before first actual use. This
does not flip a sticky server enablement setting. Default non-request is the
primary protection against surprising cost or slowdown from new features.

The server normally permits such requests. Resource admission still passes
through one server-owned `is blocked` policy decision, initially equivalent to
`false`. A future environment pin or server-state CRUD value may feed that
decision without changing the demand protocol. A durable **Block all clients**
UI may remain a proposal forever: it is an exceptional deployment override,
not a requirement for routine personal use or an accidental second default-off
gate. The UI labels the implemented scopes explicitly: **This client requests
readiness** for client opt-in and **Applies to all clients on this server** for
warm retention and any future block.

## Demand leases and warm retention

The server aggregates leases for each underlying costly resource. One valid
lease is enough to start or retain the resource; releasing one lease affects no
other lease. A socket disconnect, client generation change, or bounded lease
expiry releases abandoned demand.

A lease carries explicit, bounded resource coverage. For live project
monitoring, client opt-in immediately requests preparation for that client's
recently visited projects. The server watches the union requested by all
qualifying clients; overlapping requests share one project watcher set. As a
client's recent-project set changes, it replaces its own coverage without
removing coverage another client still requests. Each project enters warm
retention independently after its final demand disappears. The server owns a
maximum coverage bound so an old or faulty client cannot request an unbounded
watch set.

The initial client opt-in is qualifying activity and starts preparation
immediately. Later lease renewal must represent recent activity from a client
that still has the feature enabled, not merely an open browser, a persisted
preference, or generic connection heartbeats. Reconnect, foreground app use, a
visible relevant workbench, an active search surface, or a new search request
may qualify according to the feature contract. This keeps a regularly used
enabled client ready without allowing a forgotten tab to renew forever.

After the last qualifying activity, the resource remains fully current for a
server-configured warm-retention period. New demand during that period cancels
retirement without rebuilding. When the period expires, the server stops the
ongoing work and releases its active resources. The default and allowed range
may differ by resource because watcher re-enumeration, index catch-up, memory,
file descriptors, CPU, and storage have different costs.

Warm retention is not permission to evade a resource ceiling or an opened
safety circuit. Those controls may stop the resource immediately and must
expose the resulting degraded state.

The same mechanism applies beyond filesystem notification:

- Live project monitoring keeps its watcher and derived view current during
  warm retention so a likely return does not pay watcher restoration and a
  full reconciliation scan. Watcher preparation for the enabling client's
  bounded recent-project set begins at client opt-in, not at the first Source
  Control visit.
- A future per-session or all-sessions full-text index is first built only
  after a client opts into the search feature and sends its preparation
  request. It may keep consuming incremental changes while warm. After
  retirement, durable index files may remain as rebuildable server data, but
  the index is stale until catch-up completes and must not silently claim
  complete current results.
- Several features backed by one index or watcher set contribute leases to the
  shared underlying resource rather than starting duplicate maintenance.

Server restart restores durable policy, not demand leases. A resource starts
again only after new demand unless a separately named operator policy
explicitly requires continuous operation.

## Simple Settings UI

Every server-owned control is labeled **Applies to all clients on this
server**. Entering its Settings pane reads or revalidates the authoritative
server snapshot; the browser does not initialize it from `localStorage` or an
indefinitely fresh prior visit. A write happens only on the control's explicit
commit behavior, and the server's response becomes the displayed value.

Active clients receive a settings generation or changed snapshot when another
client commits. Last-writer-wins serialization may order simultaneous writes,
but an older client cache must never silently overwrite a newer value, and one
client's lease release is not a settings write.

A demand-managed feature presents a small resource card:

- The ordinary feature control is the client-scoped **Prepare and keep ready
  when this client is active** opt-in and defaults off for a new feature.
  Turning it on notifies the server immediately; readiness is not deferred to
  the first operation.
- **Keep ready after last enabled-client activity** is the server-wide
  warm-retention duration. Its copy explains that the server continues watcher
  or index maintenance during this interval to avoid restoration cost.
- **Status** reports `In use`, `Keeping ready`, `Idle`, `Blocked`, or a named
  degraded state, with useful aggregate detail such as the number of demanding
  clients, covered projects or indexes, and the warm-until time. It does not
  expose client identities unless diagnosis needs them.
- **Stop current use** revokes current leases and bypasses the current warm
  period once. It does not change admission policy. The UI states: **Stops
  current server work; any client may start it again when needed.**

An advanced **Block all clients** control is only a possible future UI over the
reserved admission check. If it is ever added, it is clearly separate from
client opt-in, defaults to requests allowed, and is not presented as a routine
way to save resources. Implementing the check does not require implementing
the control or persisting a block value now.

Calling the last action **Off** would be misleading because a subsequent
request can restart the feature. A client whose generation was revoked must
not reacquire solely through a background renewal loop; it needs new qualifying
activity or an explicit request. This makes the stop action effective until a
client actually re-requests while preserving normal automatic recovery for a
regularly used feature.

## Environment variables

Environment variables remain appropriate for startup and deployment concerns,
including historical one-off server settings, but their relationship to the
stored server value must be explicit:

- An environment-pinned value is authoritative, restart-bound, read-only in
  the web UI, and labeled with its source. The UI must not offer a writable
  control whose result the environment silently overrides.
- A legacy environment fallback applies only while no explicit server value is
  stored. The UI represents that state as **Inherit environment/default**;
  saving an explicit value overrides the fallback, and clearing it restores
  inheritance.
- An ordinary persisted server setting is editable through the web UI and
  takes effect according to its stated apply behavior.
- Client demand is never an environment variable or persisted setting. It is
  live protocol state.

Migration from a one-off environment variable to stored configuration must
preserve an operator's explicit choice and show which source currently wins.

## Current implementation and mismatch

`ServerSettingsService` persists one server-wide snapshot in
`server-settings.json`; the `/api/settings` routes read and mutate it. The
client `useServerSettings` hook shares an in-memory snapshot per source and
revalidates on refresh or reconnect. It has no browser-local persistence for
these fields, but it also has no cross-client settings-change subscription and
can treat a retained snapshot as fresh indefinitely. The target contract
therefore requires entry-time revalidation or server-pushed generation
invalidation.

Live worktree monitoring already has part of the desired resource ownership:
`ProjectWorktreeSubscriptionManager` aggregates project subscribers and closes
watchers after the final release, while `projectWorktreeStore` owns client-side
leases. Its persisted `liveWorktreeMonitoringEnabled` value is currently a
global gate that conflates a client's feature opt-in with a durable server
block, so any client can turn it off for all other clients. The target model
makes ordinary enablement a default-off client preference that produces demand
and leaves the server permitted by default. It does not yet model aggregate
qualifying activity, configurable warm retention, one-shot Stop current use,
or cross-client settings coherence.

`envSettings` supplies the read-only Environment inventory. Some settings,
including deferred-join timing, compose anchors, and turn timestamps, retain
environment fallbacks. Their eventual UI must distinguish an inherited value
from an explicitly stored value rather than materializing a browser's assumed
default.

## Acceptance outcomes

- A newly introduced costly feature receives no demand until a client opts in;
  the server does not need a second default-off policy to prevent surprise
  cost.
- Client opt-in immediately starts server preparation, so an expensive index
  or watcher set can become ready before the client's first actual use.
- Live project preparation covers the bounded union of recently visited
  projects reported by enabled, qualifying clients; one client's coverage
  update cannot remove another client's project demand.
- A regularly active client keeps the resource demanded even when another
  client releases its lease, changes a browser preference, or disconnects.
- A client that disappears without cleanup stops contributing demand within a
  bounded lease deadline.
- The resource remains current for the configured interval after the last
  qualifying activity, then retires without a browser having to write `Off`.
- Stop current use releases current work and warm retention, but the next real
  feature request can restart it without changing server policy.
- A settings pane opened on any client shows current server state, and a commit
  on one client becomes visible to other active settings panes.
- Server restart retains policy and environment precedence but discards demand
  leases and one-shot runtime actions.
- An environment-pinned setting is visibly read-only; a legacy fallback is
  visibly inherited and can be restored by clearing an explicit stored value.
- A retired index never presents stale partial results as complete, and shared
  backing resources do not duplicate work for multiple feature leases.

## Related contracts

- [Settings UI placement](settings-ui-placement.md) distinguishes browser,
  server, provider, session, and runtime scopes.
- [Live worktree resource safety](../docs/tactical/113-live-worktree-resource-safety.md)
  owns the current watcher safety and platform-specific behavior.
- [Prompt-cache keepalive](prompt-cache-keepalive.md) establishes the existing
  active-client lease precedent for recurring server work.
- [Server cache publication safety](server-cache-publication.md) owns
  generation fencing and serialized publication for retained server state.
- [Hard development rules](hard-development-rules.md) requires configuration
  precedence and migration to preserve explicit operator choices.
