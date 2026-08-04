# Provider Child Sessions

> Provider child sessions are provider-launched units of delegated work that YA
> discovers from provider persistence and displays beneath their canonical YA
> parent session without promoting provider-native child IDs into YA session IDs.

Topic: provider-child-sessions

Related topics: [provider-session-tree](provider-session-tree.md),
[session-detail-data-layer](session-detail-data-layer.md),
[vanilla-defaults](vanilla-defaults.md),
[codex-sessions](codex-sessions.md)

## Identity contract

The parent YA URL session ID remains canonical. Claude child transcript IDs and
Codex child thread IDs are provider-native handles used to find child content;
they must not become top-level `AppSessionSummary` rows, URL session IDs, or
process identities merely to make the child visible.

This differs from a provider session tree. A tree projects parent links within
one provider transcript. Provider child sessions are separately executed work
launched by a parent tool call, possibly with their own provider transcript.
They also differ from YA-owned `/btw` asides, which are real YA sessions with
their own canonical YA session IDs.

`ProviderChildSessionSummary` is the shared navigation shape. It carries the
provider-native child ID, canonical parent ID, launch tool-call ID and provider
description/type when available. `ISessionReader.listProviderChildSessions`
is the provider boundary that supplies these summaries.

## Provider persistence

Claude's current SDK stores child JSONL and metadata sidecars below
`<project session dir>/<parent YA session id>/subagents/`. The metadata sidecar
is authoritative for `toolUseId`, description, agent type, and spawn depth.
The older project-level `subagents/` and `agent-*.jsonl` layouts remain readable
for inline transcript compatibility, but do not provide enough parent scope for
the navigation summary contract.

Codex stores a child as a separate rollout. The parent rollout's `spawn_agent`
function call/output pair supplies the launch tool-call ID, child thread ID,
role/prompt, and optional nickname; the child rollout supplies its durable
content and timestamp. Child rollouts remain excluded from top-level session
and project counts.

## Presentation contract

Provider child summaries are nested beneath the parent process on **Agents**.
Session-list cards repeat the child descriptions, while compact sidebar rows
show a child count with the descriptions in the tooltip. Every row navigates to
the parent YA session, where the existing Task/Agent renderer owns expansion of
the actual child transcript.

This is not optional YA-novel behavior under
[vanilla-defaults](vanilla-defaults.md): it restores visibility for work the
user explicitly caused through a first-party provider feature, and it adds no
new action or provider state mutation. A future interactive child-management
surface would need its own capability and default analysis.

## Freshness and resource use

Child discovery is filesystem- and rollout-backed; it does not spawn a provider
runtime. Claude JSONL and metadata creation events are both classified as
`agent-session` changes. The retained process snapshot also revalidates for
generic process and session progress, including `session-updated`; therefore a
provider-child implementation must make unchanged transcript versions cache
hits and must not turn ordinary token/file churn into a full parent-transcript
parse. Child creation may invalidate the bounded child projection. An append
with no child lifecycle record must cost at most incremental append inspection,
not a replay from byte zero.

The Codex implementation currently violates this contract.
`createProcessesRoutes` enriches every active and recently terminated row with
`listProviderChildSessions`. `CodexSessionReader.listProviderChildSessions`
then calls `readEntries` with `cache: false`, parsing the complete parent
rollout on every process-snapshot refresh. The 2026-08-04 investigation in
[`docs/tactical/089-main-thread-startup-cpu-investigation.md`](../docs/tactical/089-main-thread-startup-cpu-investigation.md)
demonstrated sustained multi-core CPU and hundreds of logical GiB of repeated
input from that path. The owning correction is a shared, versioned child-summary
projection with in-flight coalescing and bounded/incremental append handling;
generic process refresh must consume that projection rather than full entries.

A regression for this boundary should issue repeated process refreshes against
one unchanged large parent rollout. After at most one initial child-projection
build, it must observe zero full-entry parses. Appending ordinary non-child
records must not rebuild from byte zero; appending a spawn/lifecycle record
must update the child summary without retaining the complete entry array.

Inline content follows the heavier session-detail path. Current Claude streams
route content by the provider child ID and map a parent tool call only when that
ID is actually present. Reload and lazy-load endpoints pass the canonical
parent ID into the reader, which makes current-layout discovery parent-scoped.

The Agents and session-list projections currently cover active and recently
terminated parent processes, matching the process snapshot's retention. A
durable historical-session projection should extend the indexed session-summary
contract rather than making every global list read rescan every possible child
directory.
