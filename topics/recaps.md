# Recaps

> Recaps are short on-return summaries — what the agent did or is doing
> while the user was away — surfaced as a turn-style system message in
> the session view without polluting the underlying provider transcript.

This topic covers YA's "away summary" pseudo-turns. The Claude TUI emits
recaps natively (system subtype `away_summary`); YA reproduces the UX
across providers and across the SDK / TUI gap, since the SDK's
`--print --output-format stream-json` mode does not run the TUI's
idle-detection effect that triggers native recap emission.

See also: [fork-recap.md](fork-recap.md) for the supervisor-level worker
lifecycle of the `fork` recap strategy (dedup, in-turn deferral,
cancellation on activity) and the current trigger/threshold gaps.

## Contracts

- A recap is a server-emitted message with `type: "system"`, `subtype:
  "away_summary"`, and a plain-text `content` field. Provider-emitted
  recaps (e.g., a future SDK that exposes them natively) and YA-emitted
  recaps share the same on-wire shape so the client renderer does not
  need to know which side produced them.
- Recaps must not become part of the provider's persisted transcript.
  The JSONL session file represents the underlying agent's
  conversation; recaps are a viewer affordance and must not be stored as
  user/assistant turns or fed into future provider context.
- YA-synthesized recaps must be durable. They are persisted as YA-owned
  metadata overlay rows (`SessionMetadataService.recapMessages`) and merged
  into session detail/list reads. This makes them survive `reyep`, server
  restart, and reopening the same session from another device without
  polluting the provider transcript.
- Provider-native recaps are preferred. In tailed and forked modes, YA waits
  a bounded grace window for a native `system/away_summary`; if it arrives in
  time, YA uses it, resets the fallback activity/return event, and suppresses
  the synthetic fallback. Tailed/forked are therefore eventual-recap
  guarantees, not native-recap replacements.
- A live-observed provider-native recap may also be mirrored into the YA
  metadata overlay as `provider-native`. This preserves the native-preferred
  outcome across restart/reopen and is deduped against any provider row that
  later appears in the persisted transcript.
- Recap generation is the provider's responsibility. Providers that
  cannot generate one cheaply (no cache fork, no second model handy)
  may decline; YA surfaces this as a capability gap rather than
  silently doing nothing.
- Triggering is YA's responsibility. The client arms an away timer when the
  session view is hidden/left and fires it (session-keyed) after the
  `recapAfterSeconds` threshold; the server decides whether the session has
  anything new to summarize. Because the request is keyed by session, not
  process, it survives a server restart: a *displayed* fork-mode session whose
  process died is revived and recapped from its transcript (never preempting a
  live worker). A session explicitly terminated with automatic resume disabled
  is never revived for a recap; Activate, Send, and equivalent user actions
  remain deliberate continuation paths. See [fork-recap.md](fork-recap.md) for
  the revive/no-preempt lifecycle.
- Stop/Interrupt and Terminate are explicit recap boundaries. Either action
  cancels a recap deferred behind the active turn, aborts an in-flight forked
  recap, and durably rejects later time-based recap requests until YA accepts a
  fresh user-authored turn for that session. The pause survives provider
  process replacement and server restart; hidden/internal and automatic
  heartbeat turns do not clear it. This recap pause is separate from heartbeat
  policy: Interrupt leaves
  heartbeat eligibility unchanged, while Terminate's existing resume exemption
  disables heartbeat turns and automatic resume. A fresh user turn clears the
  recap pause after either action; it does not implicitly re-enable heartbeat
  turns disabled by Terminate. See [heartbeat.md](heartbeat.md).
- Recap configuration is durable. `recapAfterSeconds` and `recapMode` are
  persisted in session metadata, so a session's recap preference survives a
  process death / reactivation and is what tells a cold session whether and how
  to recap.
- The hint suffix the Claude TUI appends to its first few recaps —
  ` (disable recaps in /config)` — is provider-specific noise. YA must
  strip it before rendering so users do not see CLI-only configuration
  instructions for a setting that is not theirs to change from YA.
- Recaps do not steer, queue, or interrupt the active turn. If a turn
  is mid-stream when the user returns, the recap waits until the turn
  resolves so it cannot interleave with live assistant output.

## Invariants

- One recap per "return event". Repeated visibility flips within a
  short window collapse to a single trigger; the user should not see a
  stack of recaps after wiggling focus.
- A recap with no new agent work to describe is suppressed. The freshness
  floor is the *later* of the user's leave time and the last emitted recap
  for the session (`Supervisor.recapFloorMs`): a return event with no
  assistant output since the last recap would regenerate the same summary
  from the same context — wasted work and a duplicate row. An empty or
  near-empty recap is worse than no recap.
- At most one recap row per transcript position. A newer recap supersedes
  an older YA-overlay recap that has no provider content after it
  (`mergeRecapMessages`); an older recap stays visible only when real
  transcript content follows it, where it reads as a milestone marker at
  the point it covered. Provider-emitted recap rows are never removed by
  this supersede.
- Recap text length is bounded by the provider's prompt (under ~40
  words for Claude-shape recaps); YA must not pad, decorate, or attach
  follow-up tool affordances that would invite further interaction with
  the recap message.
- Recaps survive reload as viewer state. YA persists synthetic recaps, and
  live-observed native recaps, in session metadata and overlays them into
  the transcript view. The provider transcript remains the provider's record.
- Session lists and hovercards treat a fresher recap as the current ending
  text (`lastAgentText`) immediately on emission and after reload. A later
  real assistant turn naturally supersedes it through the normal summary path.
- A recap landing never flips its session unread. Recaps describe provider
  content; they are not provider content. The overlay's `updatedAt` bump is
  display/order freshness only — every server `hasUnread` computation compares
  `lastSeen` against the pre-overlay (provider transcript) `updatedAt`, so a
  fully-seen session stays unbolded in the sidebar/lists/inbox when its recap
  arrives, while genuinely unseen provider output still marks unread on its
  own. (This deliberately reverses the earlier overlaid-freshness unread
  computation from "Tighten recap overlay cursor and freshness handling".)
- Recap rendering is read-only. There is no recap-specific reply box,
  thumbs, retry, or dedicated copy-to-composer action; clicking the recap row
  should not change provider state. The recap body text still participates in
  the ordinary selection quote-comment pipeline, so a selected recap span can
  become a `>` quote in the composer like other transcript content.

## Configuration and Native Capability

Common side-query configuration lives in
[side-session-config.md](side-session-config.md); next-turn prediction lives in
[prompt-suggestions.md](prompt-suggestions.md).

New sessions should not start with YA-simulated recaps enabled by
default. A provider with native recap support may default to native recaps
because YA does not need to spawn a side session, but the UI must still expose
`Off`: native recaps are not free, and the user must be able to disable them
for a new or existing session.

For simulated recaps, YA needs an explicit configuration surface rather
than a hard-coded model choice. The side model is shared for the parent
session's silent helper features; recaps must not get a separate
per-feature side model. A recap-specific setting may instead choose
execution mode, such as using the shared helper side session or forking
the main session/original model for higher fidelity. The latter strategy,
extended with an after-turn pointer and free-text instructions, is what
[fork-from-turn](fork-from-turn.md) uses for fork-after-summary.

`Cheapest` is the default helper model token. Providers map it to the
appropriate cheap side model for their backend, such as Haiku for Claude, so
the UI does not need to hard-code provider model names.

The UI locations are:

- New-session form: a `Recaps` control in the all-provider defaults above the
  AI Provider boundary. It chooses `Off`, provider-native recaps when supported,
  or simulated recaps through the shared helper side session or forked fallback
  path.
- Settings -> Providers: the default recap mode for future sessions and the
  shared helper side model, including `Same as main session`. The helper model
  selector is labeled `Tailed Recap Model` and appears for both direct tailed
  recaps and forked recaps, because fork generation falls back to the tailed
  helper path when the provider cannot fork or returns no fork summary.
- Existing session menu: a `Recaps...` item for the active process. It changes
  future away-return triggers without restarting the parent session and without
  rewriting prior recap messages.

This mirrors native prompt suggestions. The current Claude path already
exposes native prompt suggestions (`promptSuggestions: true`) and the
client renders `prompt_suggestion` messages. If YA later simulates
prompt suggestions for providers without native support, it should use
the same side-session configuration as simulated recaps: both are
non-steering side queries over recent context, and both need the same
bounded lifecycle, session-level model choice, and restart behavior.

Hot or cold YA restarts can already reduce normal-workflow reliability
because providers do not all resume cleanly. Side-session features must
not amplify that: keep simulated recaps opt-in, keep side queries
bounded, and do not require restarting the parent provider session to
change recap configuration for future sessions.

## Representative Change Types

- Adding a provider implementation of `AgentSession.requestRecap` (or
  raising the provider capability flag).
- Changing the client trigger heuristic (idle threshold, focus events,
  network reconnect treated as "back from away").
- Changing recap rendering: dimmed turn card, side-dot glyph, position
  in the message list, stripping of provider-specific hint suffixes.
- Changing how the server records its "last user activity" timestamp,
  since the recap trigger depends on it.

## Decision: Native-Preferred Fallback and Helper Placement

This revises the original "native vs simulated" split into a user-facing
"recaps on/off" contract with provider-owned recaps preferred.

When recaps are on for a provider that emits `away_summary` natively, YA should
first show provider-emitted recap rows when they arrive. If no native recap
arrives by a bounded deadline for the return event, YA may run its own recap
helper and emit the same `system` / `away_summary` shape. That fallback must be
deduped against a late native row: one visible recap per return event, with the
native row preferred when both exist.

The fallback deadline is bounded, not an unbounded "wait and hope" state.
The current server implementation waits a short post-return grace window for
providers that advertise native recap support, checks again after helper
generation, and suppresses the synthetic row if a native row arrived during
that window.

Current implementation facts:

- Claude's cheap `side-session` recap strategy does **not** fork and does not
  run an inline hidden turn. It starts a fresh SDK `query()` with
  `persistSession: false`, feeds bounded recent assistant text into the prompt,
  and emits the generated text as a synthetic recap.
- Codex's cheap `side-session` recap strategy likewise starts an ephemeral
  helper thread over copied recent assistant text, not a fork of the source
  thread.
- Retitle and fork-after-summary already use the high-fidelity fork-backed
  `strategy: "fork"`: create a temporary real fork, run one helper turn there,
  then archive/hide the generator so it does not clutter normal session lists.
- The installed Claude SDK exposes `promptSuggestions` as a public query option
  but no public `awaySummary` / `awaySummaryEnabled` query option. Its bundled
  implementation contains an internal `awaySummaryEnabled` settings schema
  entry, marked hidden from public SDK types. Treat any attempt to drive that
  setting as a separate probe, not as an assumed API contract.

Add a recap helper placement option for fallback generation:

- **Recent-text helper**: the current cheap path. It copies bounded recent
  assistant text into a fresh non-persisted helper session/thread. It is clean
  and cheap but loses full provider context and prompt-cache warmth.
- **Temporary fork helper**: create an archived/hidden generator fork, run the
  recap prompt there, emit only the resulting recap to the source view, then
  clean up or keep the generator hidden like retitle and fork-after-summary.
  Prefer this when the provider supports real transcript forks and fidelity or
  cache warmth matters.
- **Inline hidden turn**: run the helper against the live/source provider
  context only if the provider exposes a verified "hidden from transcript /
  skip transcript" primitive. This could be fastest and most context faithful,
  and arguably harmless to model context if truly hidden, but it is unsafe to
  emulate with an ordinary visible user turn. For Claude SDK, no public
  `skipTranscript` option is currently exposed; the TUI's native recap path may
  use internal machinery that YA cannot assume.

The default should be `auto`: prefer native provider rows; on fallback, prefer a
temporary fork when the provider has a real fork primitive; otherwise use the
current recent-text helper. Inline hidden turns require an explicit provider
capability because a fake-hidden turn that reaches the persisted transcript or
future model context violates the recap contract.

Remaining probes:

- Test whether the internal `awaySummaryEnabled` settings key can be supplied
  through supported SDK settings plumbing, and whether it affects `--print`
  / stream-json mode at all.
- Measure a live native-on session: time from last activity to native recap,
  from return/catch-up to display, and fallback behavior when the native row
  never appears.

## Tests That Should Fail On Contract Regressions

- A recap message is not written into the persisted Claude JSONL
  transcript.
- Two rapid visibility flips within the suppression window produce at
  most one recap.
- A recap fired against a session that has had no assistant output
  since the user left does not surface in the message list.
- A second return event with no assistant output since the last emitted
  recap does not generate or surface a second recap.
- Stop/Interrupt and Terminate drop a recap deferred behind the active turn and
  reject later away-timer requests until a fresh visible user turn is accepted,
  including after process replacement or server restart. Hidden control and
  automatic heartbeat turns do not clear the pause.
- Interrupt does not change heartbeat eligibility. Terminate clears heartbeat
  opt-in and blocks automatic resume through its separate durable exemption.
- Two persisted overlay recaps with no provider content between them
  render as one row (the newest); with provider content between them,
  both render, the older inline at the point it covered.
- The trailing ` (disable recaps in /config)` text is stripped from
  rendered content but the rest of the text is preserved verbatim.
- Recap rendering does not expose retry or recap-specific action chrome; the
  only path that can move recap text into the composer is the shared
  selection quote-comment path used for other transcript content.
- A recap overlay newer than a fully-seen session's transcript leaves
  `hasUnread` false in session detail, project lists, and global lists, while
  the row's `updatedAt` still reflects the recap timestamp.

## Decision: YA synthesizes rather than passing through

The Claude TUI generates recaps natively (system subtype `away_summary`
emitted by a TUI-side React effect that detects idle-then-return,
runs a cache-fork mini-inference, and renders the result). We do not
get them for free in the SDK path:

- `awaySummaryEnabled` exists in the CLI settings schema but is marked
  `@internal Hidden from public SDK types until external launch`, so
  there is no `awaySummaries: true` query option analogous to
  `promptSuggestions: true`.
- The trigger and fork live inside the TUI's React tree. The SDK
  spawns the CLI with `--print --output-format stream-json`, where
  the TUI never mounts. Setting `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=true`
  does not change that — the gate it controls only matters when a
  TUI is running.
- The TUI's internal recap fork uses `skipTranscript: true` to keep
  the JSONL clean. That flag is not exposed in the SDK's `query()`
  options, so a `resume:`-based recap on YA's side would append a
  visible turn to the underlying transcript.

YA therefore synthesizes recaps server-side: on a client "user
returned after ≥N min away" signal, the provider runs an ephemeral
`query()` with `persistSession: false`, feeds in recent assistant
text, and YA emits a synthetic `away_summary` system message into the
session's stream. This matches the on-wire shape the TUI would emit,
so the same client renderer handles both — once the SDK exposes
recaps natively, the YA-side path can become a fallback rather than
the default.

Alternatives considered:

- **Wait for SDK exposure.** Cheapest, but no timeline; meanwhile the
  feature is simply absent. Rejected as the v1 path because the UX
  payoff is concrete and the cost of the YA-side path is small.
- **Resume the live session for a one-turn recap.** Cheap (warm
  cache), but appends a user/assistant pair to the JSONL. Violates
  the no-extra-turns invariant above.
- **Run the CLI in a mixed-mode shim that mounts the TUI.** Possible
  in principle but invasive; loses the clean control protocol the SDK
  query provides, and the trigger still needs YA-side signals because
  the TUI's "user away" detection assumes a local terminal.

## Relationship to Side Sessions

The recap implementation is the first concrete example of a YA-simulated
helper feature: it runs outside the parent provider turn, reads bounded recent
parent context, and emits viewer state rather than provider transcript turns.
The shared configuration and catch-up rules live in
[side-session-config.md](side-session-config.md).

The important product constraint is that recaps do not get a private model or
side-session choice. If YA later simulates prompt suggestions or independent
quick questions, those features share the same session-level helper side
session and catch-up cursor. A recap-specific switch may choose behavior such
as "off", "native", "shared helper", or "fork main session using the original
model", but it must not introduce another hidden helper model setting.

`/btw` asides remain separate user-visible work streams, covered by
[provider-agnostic-btw-asides.md](provider-agnostic-btw-asides.md). They may
reuse the same bounded replay policy for unsupported providers, but their
parent/child UI and persistence are not the silent-helper recap path.
