# Agents Multi-Session Activity Preview

> Proposal: let the Agents page optionally show a bounded, condensed view of
> what each live session is doing, using recent visible agent text or thinking
> for active work and the last completed agent output for recently idle work.
> This records an experiment direction only; it is not approved for immediate
> implementation.

Topic: agents-activity-preview

See also:

- [`agents-process-observability.md`](agents-process-observability.md) — the
  separate host process inventory, external discovery, and resource-metrics
  proposal.
- [`inbox.md`](inbox.md) — the attention-oriented session tiers that remain
  distinct from process monitoring.
- [`session-hovercard-recent-activity.md`](session-hovercard-recent-activity.md)
  — the existing durable `lastAgentText` excerpt and its previously recorded
  live-tail phase.
- [`session-summary-fidelity.md`](session-summary-fidelity.md) — bounded list
  projections, complete summaries, and partial-observation rules.
- [`portable-transcript-compiler.md`](portable-transcript-compiler.md) — the
  normalized semantic projection boundary; a preview must not become a second
  transcript compiler.
- [`ui-architecture.md`](ui-architecture.md) — shared presentation should live
  at the model/render boundary rather than in view-specific DOM rewriting.
- [`vanilla-defaults.md`](vanilla-defaults.md) — the activity mode is explicit
  and default-off while its value is unproven.
- [`architecture-mandates.md`](architecture-mandates.md) and
  [`server-message-routing.md`](../docs/project/server-message-routing.md) —
  subscription ownership, replay, fan-out, catch-up, and resource quiescence.

## Motivation

When several sessions are active concurrently, the existing surfaces answer
different questions:

- **Inbox:** what needs attention, has recent activity, or is unread?
- **Agents today:** which YA-owned provider processes are alive, and what are
  their state, uptime, context usage, queue depth, and provider?
- **Session detail:** what is the complete conversation and tool history?

The missing supervisor view is: **what is every running session doing right
now?**

First-party Codex and Claude desktop applications provide a useful model. They
show a compact current activity block, keep the newest meaningful text
prominent, and collapse or replace older intermediate activity when the agent
moves to the next phase. YA can apply that interaction to several session cards
at once without rendering several miniature full transcripts.

The Agents page is the initial home because its rows already correspond to
owned provider processes. The process-observability proposal may add read-only
external rows, but this activity-preview proposal supplies content only where
YA has the necessary normalized provider stream. Inbox should remain sparse
and attention-oriented. Inbox's `active` tier also includes queued or inferred
work that is not the same as an actively streaming provider process; the two
classifications must not be silently unified.

## Proposed Product Shape

Add one page-level **Show activity** control to Agents. The initial experiment
is explicit and default-off. With the control off, Agents remains observably
unchanged.

The control applies to all process cards because the goal is simultaneous
scanning. Requiring expansion of every card would defeat the multi-session use
case. A later browser-local preference may remember the choice, but the first
experiment need not persist it.

Each card receives a fixed-height preview region:

| Process state | Primary preview |
| --- | --- |
| `in-turn` | Current visible agent prose or permitted visible thinking. |
| Tool-heavy phase | A terse activity label such as `Running tests…` only when no useful prose is current. Never raw tool arguments or output. |
| `waiting-input` | The outstanding question or approval request, taking precedence over ordinary activity. |
| `idle` | The last completed visible agent excerpt or freshest recap. |
| `terminated` | No preview by default; the termination reason remains primary. |

“Recently idle” means idle processes still retained by the Agents process
surface. It does not expand Agents into a list of every recently completed
session. Sessions whose provider process has been reaped remain discoverable
through Inbox and ordinary session lists.

### Compact feed behavior

The preview is a semantic tail, not a chronological transcript:

- The newest meaningful block is expanded.
- At most one immediately preceding meaningful block may remain as a muted,
  single-line breadcrumb if testing shows it improves comprehension.
- When activity advances from thinking to a tool phase to agent prose, older
  intermediate material collapses or disappears instead of accumulating.
- Tool calls, command output, diffs, file contents, images, system messages, and
  synthetic transport details do not render in the preview.
- A short tool-phase label is a liveness fallback, not a tool inspector.
- The preview follows its own newest content without moving the outer page or
  reordering cards.

The default preview should prefer a line clamp or top fade over making every
card an independent scroll container. A user-triggered per-card expansion may
offer a bounded scrollbar if the experiment shows that more context is useful.
Nested scrolling must remain practical on narrow touch screens.

Preview text should remain selectable where that does not conflict with the
card's navigation gesture. Continuous streaming updates must not be exposed as
assertive live-region announcements; several concurrent agents must not produce
an unusable accessibility announcement stream.

### Thinking and tool visibility

Only thinking already permitted by the user's existing thinking-display policy
may appear. The preview must never reveal hidden reasoning because a different
surface subscribed to the same provider stream.

Tool details are intentionally excluded even when the full session UI would
render them. If the only useful liveness signal is a tool phase, the preview may
show a provider-independent, human-readable label. It must not expose command
lines, file contents, arguments, output, or approval-sensitive details.

## Data Model: Durable Result Versus Ephemeral Activity

The preview combines two facts with different lifetimes:

```ts
interface SessionActivityPreview {
  currentActivity?: {
    phase: "thinking" | "responding" | "tool" | "waiting";
    text?: string;
    updatedAt: string;
    partial: boolean;
  };
  lastCompletedText?: string;
}
```

The exact type and names are illustrative, but the separation is a contract:

- `lastCompletedText` corresponds to the existing bounded `lastAgentText`
  summary or recap. It can survive reconnects and process idleness.
- `currentActivity` is an ephemeral observation of the live process. It may be
  absent after reconnect, must be cleared when no longer current, and must not
  be persisted as transcript truth.
- Live thinking or tool status never overwrites `lastAgentText`.
- While running, presentation prefers `currentActivity` and falls back to
  `lastCompletedText`; while idle, it shows only `lastCompletedText`.
- Omitted partial observations preserve a known durable excerpt. An explicit
  activity clear may remove only the ephemeral field.

This follows the session-summary fidelity rule: a newer, lower-fidelity live
observation does not downgrade a richer completed summary.

## Client-Only Experiment

A first experiment can use existing server behavior:

1. When **Show activity** is on and Agents is visible, subscribe through the
   current source transport to each `in-turn` or `waiting-input` process.
2. Reuse the existing per-session late-join behavior: approximately 15–30
   seconds of bounded message replay plus accumulated current streaming text.
3. Fold incoming unified messages into a small pure activity-preview
   projection. Retain only the current semantic block and, if chosen, one
   predecessor. Do not mount `useSession`, `MessageList`, rich markdown/tool
   renderers, or a full session-detail store per card.
4. Obey the existing response-streaming and thinking-display preferences.
   Without live deltas, completed messages can still update the preview.
5. Coalesce high-rate changes before React state. A starting ceiling of roughly
   two to four visible updates per second per active card is sufficient for an
   experiment; measurement should choose the final cadence.
6. Populate idle previews from an already-known `lastAgentText` or the existing
   lazy preview-refresh path. Absence degrades to no preview rather than an
   automatic full-transcript load.
7. Close every stream and cancel every pending update when activity mode is
   disabled, the row leaves scope, the source changes, or the page unmounts.

The activity projector should reuse the normalized provider-output and
transcript-projection semantics at their owning boundary. It must not introduce
provider-specific text scraping inside `AgentsPage` or establish a parallel
render pipeline.

### Limits of client-side filtering

Client-side display filtering does not avoid transport cost. The browser may
still receive and decode tool events or large tool results before discarding
them. With many simultaneous sessions, the experiment also creates one logical
session subscription per active process, although multiplexed transports can
carry them over one connection.

This is acceptable for a user-invoked experiment if memory is bounded, updates
are coalesced, and teardown is complete. It is not evidence that the same shape
should become default-on or scale to every connected source.

The experiment should measure:

- wire frames and bytes while several tool-heavy sessions run;
- browser scripting and React update time;
- retained preview memory before and after disabling the mode;
- server listener counts returning to baseline after page exit;
- reconnect behavior, including absence of duplicate or stale activity;
- usability on both desktop and a narrow touch viewport.

## Optional Compact Server Projection

A server-side compact projection is a later optimization, not a prerequisite
for validating the interaction.

If justified, it should expose the same bounded `currentActivity` model so the
UI and client store do not change. The server can discard raw tool payloads
before the wire and provide provider-consistent phase labels after
normalization. It must remain:

- ephemeral and bounded per active process;
- computed from events the owned process already receives, with no transcript
  polling or repeated file scans;
- subscriber-owned and quiescent when no visible client requests it;
- separate from complete `SessionSummary` and bounded `SessionListSummary`
  freshness;
- free of raw tool arguments, results, hidden thinking, and rich rendered HTML;
- compatible with reconnect fallback to durable `lastAgentText`.

Do not broadcast token-rate previews on the global activity bus to clients that
did not request them. A future multi-session preview channel, if needed, must
have explicit subscription lifetime and teardown. It also must not become a YA
shadow transcript or a third persistence source.

Trigger compact server projection work only when at least one of these is
observed:

- discarded tool payloads or per-session frames cause material bandwidth,
  parsing, or battery cost;
- profiles show the client-only projector cannot remain cheap at realistic
  concurrency;
- provider-specific live event differences make the client projection
  unreliable despite the shared normalization boundary;
- a future merged multi-source monitor needs a lower-cost aggregate stream.

Until then, preserve the current architectural choice that high-rate rendering
is throttled by the client and avoid reshaping Process fan-out or replay merely
for this proposal.

## Observable Contract If Implemented

- With activity mode off, Agents has the same rows, ordering, metadata,
  navigation, and resource use it has today.
- Enabling the mode never changes provider input or provider process behavior.
- Active cards show only bounded, recent, user-visible semantic activity.
- Waiting questions and approvals remain more prominent than descriptive
  activity.
- Idle previews show a completed agent excerpt or recap, never stale live
  thinking presented as a completed result.
- Hidden thinking and raw tool details never appear.
- Streaming updates do not reorder cards, scroll the outer page, or grow a card
  without bound.
- High-rate input is coalesced before React presentation.
- Disabling the mode or leaving Agents releases all preview-owned streams,
  timers, retries, and catch-up work.
- Reconnect may temporarily fall back to the durable excerpt, but it must not
  duplicate blocks or replay a superseded activity phase as current.

## Non-Goals

- Replacing Inbox or changing Inbox tier semantics.
- Showing every recent or external session on Agents. Live external process
  inventory, without invented session correlation, belongs to
  [`agents-process-observability.md`](agents-process-observability.md).
- Rendering complete transcripts, markdown, tool output, diffs, or files in
  process cards.
- Persisting a YA-owned activity transcript.
- Generating summaries with an additional model.
- Monitoring multiple YA servers in the first experiment.
- Changing provider child-session presentation; delegated-work previews can be
  considered separately after the top-level session experiment.

## Open Questions

- Is one expanded block enough, or does one collapsed predecessor materially
  improve orientation?
- Should the page-level choice persist browser-locally after the experiment?
- Does per-card expansion need a scrollbar, or is opening the session the
  clearer path to more context?
- Which small provider-independent tool-phase vocabulary is useful without
  becoming a second tool renderer?
- Should terminated cards ever retain the last completed excerpt?
- At what measured concurrency does a compact server projection become
  worthwhile?
