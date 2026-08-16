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

Grok stores `SubagentMeta` at
`<parent session dir>/subagents/<id>/meta.json` and a sibling child session
directory under the same encoded cwd. `child_session_id` equals `subagent_id`.
`GrokSessionReader.listProviderChildSessions` reads only those metas.
`getAgentSession` replays the child's `updates.jsonl`. Those child ids are
excluded from Grok top-level `listSessions` / `listSessionFiles`. Fork
`parent_session_id` on `summary.json` is not a subagent link.

## Presentation contract

Provider child summaries are nested beneath the parent process on **Agents**.
Session-list cards repeat the child descriptions, while compact sidebar rows
show the child count as a number-only pill. Its tooltip begins with an explicit
"N provider subagent(s)" label, followed by the child descriptions. The pill
uses ordinary sidebar text sizing and retains a visible gap before the project
label; neither glyph density nor title truncation may make the count or project
name overlap. A read row uses a quiet grey pill; the existing session unread
state strengthens its fill and weight, then viewing the session settles it
again without a separate child-count acknowledgement state.

The parent session header shows a count / recently-active / last-activity
strip when any children exist. Recently-active means the parent process is
`in-turn` and that child's transcript mtime is within the last three minutes.
The compact sidebar pill still opens the parent session. Child rows on Agents
and session-list cards, strip items, and the Task / spawn-agent "Open" control
navigate to the read-only nested page
`/projects/:projectId/sessions/:sessionId/agents/:agentId`. That page loads the
existing `GET .../agents/:agentId` transcript and has no composer: Claude
children have no SDK input channel. The parent YA session ID stays in the URL;
the sidebar highlights that parent while the child page is open.

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

The Codex implementation uses a source-versioned child projection shared across
reader instances. The projection retains launch and child facts, its byte
offset, and an incomplete final line, but never the full entry array. Exact
unchanged versions are cache hits; concurrent readers join one build; plain
JSONL growth inspects only the appended range; truncation, replacement, and
compressed-file changes rebuild from byte zero. Published work is re-statted
against device, inode, size, mtime, and ctime, and a late completion cannot
replace accepted state for another source version. The retained projections
share an 8 MiB process-wide byte budget.

The process-list route consumes the latest accepted projection and starts
refresh in the background. A cold projection therefore omits child enrichment
from that response instead of delaying the basic process row; a later snapshot
attaches it after publication. Direct reader callers retain fresh-by-default
semantics, retry one source race, and fall back to the last accepted projection
if the source keeps changing.

This replaces the prior violation: `createProcessesRoutes` enriched every
active and recently terminated row by awaiting
`listProviderChildSessions`, while `CodexSessionReader` called `readEntries`
with `cache: false` and parsed the complete parent rollout on every process
snapshot. The 2026-08-04 investigation in
[`docs/tactical/089-main-thread-startup-cpu-investigation.md`](../docs/tactical/089-main-thread-startup-cpu-investigation.md)
demonstrated sustained multi-core CPU and hundreds of logical GiB of repeated
input from that path.

The reproducible server benchmark uses a 6,289,985-byte synthetic parent
rollout and 20 simultaneous callers. It measured 20 legacy full parses versus
one projection build, 125,799,700 versus 6,289,985 logical source bytes (95.00%
avoided), and 183.08 ms versus 9.07 ms median wall time across five samples
(20.18x). Cold latest-accepted lookup returned in 0.535 ms. The accepted value
retained 611 estimated bytes and populated zero full-entry-cache sessions. Run
`pnpm --filter @yep-anywhere/server benchmark:codex-child-projection` to repeat
the measurement.

A regression for this boundary issues repeated process refreshes against one
unchanged large parent rollout. After at most one initial child-projection
build, it observes zero full-entry parses. Appending ordinary non-child records
does not rebuild from byte zero; appending a spawn/lifecycle record updates the
child summary without retaining the complete entry array. Truncation removes
children that are no longer in the source.

Inline content follows the heavier session-detail path. Current Claude streams
route content by the provider child ID and map a parent tool call only when that
ID is actually present. Reload and lazy-load endpoints pass the canonical
parent ID into the reader, which makes current-layout discovery parent-scoped.

The Agents projection still comes from the process snapshot. Project and
global session lists attach children for idle parents too: Claude uses the
cheap `subagents/` readdir already owned by `listProviderChildSessions`;
Codex uses only the accepted child projection and never starts a cold parent
rollout parse for a list read. Session metadata and session-detail attach a
fresh listing for the one open parent. `providerChildren` is optional on those
existing payloads; older servers omit it and the client treats absence as no
children. The nested child page uses the existing agent-session GET and does
not add a capability. A later indexed historical projection may replace the
per-parent readdir, but list reads must not parse child or parent JSONL.

## Other providers

Claude is the first provider with strip + nested page + idle-list
summaries. Remaining first-party coverage is filed as gaps, one provider
per file:

- [Codex idle/cold list and live activity](../gaps/codex-subagent-summary-visibility.md)
  — reader + child rollouts already exist; first list walk after restart
  can still omit children, and `subagent_activity` is not on the strip.
- Grok nested child discovery is landed: parent `subagents/*/meta.json`
  feeds the existing strip / page / idle list, and child session dirs stay
  out of the top-level Grok list. TUI tasks-pane kill remains out of scope.
- [Copilot event-shaped children](../gaps/copilot-subagent-summary-visibility.md)
  — no first-class YA Copilot provider; SDK/CLI children are parent-stream
  lifecycle events, not a sibling transcript tree.
