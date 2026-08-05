# Conversation View

> Conversation view is the default transcript projection that keeps user prompts,
> agent-authored text, images, and important failures visible while replacing
> routine tool activity with one compact, expandable elapsed/activity summary
> per agent turn.

Topic: conversation-view

Status: **landed** (2026-07-28).

See also:
[collapse-expand-mode.md](collapse-expand-mode.md) for richer action-outline
grouping rather than wholesale conversation condensation;
[session-ui-customization.md](session-ui-customization.md) for the configurable
toolbar surface; [ui-architecture.md](ui-architecture.md) for the render-item
boundary; [session-media-handles.md](session-media-handles.md) for transcript
media ownership.

## Motivation

YA's full transcript is valuable while an agent works, but reads, searches,
edits, commands, and tool results can make it hard to scan back to the actual
exchange—especially on a phone where scrollbar bookmarks are not practical.
The compact view must still show that work happened and allow one-step recovery
of the exact rows. It is a different view of the same loaded transcript, not a
provider-history rewrite and not deletion.

## Observable contract

- The feature and its two-bubble Session Toolbar control are **on by default**.
  The control uses the `last` narrowing tier and switches between the condensed
  conversation and full activity transcript. This is a deliberate
  [Vanilla Defaults](vanilla-defaults.md) exception approved as matching the
  normal condensed presentation of the Codex and Claude harnesses.
- The mode is browser/device-local, persists across sessions and tabs, and is
  included in browser-settings backup. The toolbar-presence choice for this
  control is also client-only: it is not sent as a
  `clientDefaults.sessionToolbarPresence` key to servers that may not recognize
  it. The last owner toggle on this browser profile is the default for newly
  opened sessions and tabs on that device; there is no duplicate default-state
  setting or cross-device last-writer synchronization. Existing stored mode and
  presence choices remain authoritative. Explicitly changing the toolbar
  control from hidden to shown activates Conversation view; merely changing a
  shown control's narrowing tier does not overwrite the current mode.
- A session or share that opens with Conversation view already active condenses
  the entire currently loaded transcript; default-on does not itself truncate
  history. Explicitly switching Conversation view from off to on in a mounted
  view starts at the latest 100 user turns. **Toolbar → Conversation View
  history** configures this browser-local activation limit from 10 to 500 turns
  in steps of 10 and includes it in browser-settings backup. The boundary is a
  user prompt: its corresponding assistant response and all following
  standalone display objects remain in order.
- When older loaded turns exist above that boundary, the ordinary top history
  affordance reports the visible turn count and reveals up to another configured
  window. If the canonical session also has unloaded history, the same action
  may request the next older page as the local boundary approaches it. Revealed
  history is ephemeral to the mounted view: it does not change the configured
  default, delete transcript data, or persist a provider/session mutation.
- Conversation view retains user prompts, session setup, transcript display
  objects, agent-authored text, ordinary system notices, warnings, and errors.
  Tool calls with media remain visible, using their existing media renderer, so
  images stay associated with the agent turn's text.
- Routine tool calls (pending, complete, or aborted), Thinking rows,
  non-failing task notifications, and subagent-activity notices condense.
  Provider plan-checklist updates rendered through the canonical `UpdatePlan`
  tool remain top-level at their transcript position: they are supervision
  state rather than routine execution and do not count as hidden activity.
  Tool errors, incomplete calls, and task notifications whose structured
  status is `failed` or `error` also retain their ordinary rows because their
  summary or output path may be the only human-readable failure detail.
  Notifications without a structured failure status remain routine activity;
  YA does not infer failure from unconstrained summary prose.
- Each assistant turn with condensed activity ends in one summary button. A
  completed summary reads like `4m · 17 activities hidden`; the live
  edge reads like `Working 4m · 17 activities`. If source timestamps are
  unavailable, the label keeps the activity count without inventing a time.
  Durations below 10 seconds retain one decimal place; durations from 10
  seconds onward use whole seconds (or the existing compact minute/hour form).
  Its disclosure triangle stays legible at the compact text size and is
  optically centered beside the live-status dot in both directions without
  changing the button's hit target.
- Clicking the summary restores every condensed row in its original transcript
  position. The summary remains at the turn end as the one-click collapse
  control. While reading above the live edge, direct expansion or collapse
  keeps that clicked summary at the same viewport position even though the
  document height and scrollbar change. Manual expansion remains sticky while
  that session view stays mounted.
- Switching the whole mode preserves bottom-follow when already at the live
  edge; otherwise it restores the visible render-row anchor (with height-delta
  fallback) so the reader does not jump to an unrelated passage.
- Switching the whole mode also preserves manual disclosure state for ordinary
  tool rows, tool-result media previews, and explored-tool outline groups while
  the session view remains mounted. The state is a sparse set of controls that
  differ from their default: returning a control to its default removes its
  entry. Presentation-only hiding, including Conversation view and ordinary
  scrolling, does not discard an entry. Active-window trimming prunes entries
  whose owning render item has actually left the loaded transcript; revealing
  an older still-loaded turn through **Load earlier** therefore retains its
  state, while refetching an evicted turn starts from the normal default.
- Search follows the currently projected transcript. Condensed tool/thinking
  text does not produce hidden matches; expanding its turn makes those rows
  searchable again.
- The thinking-transcript visibility control composes with Conversation View
  instead of being shadowed by it. When thinking is visible, a compact preview
  follows the final activity summary on the same wrapping row. A completed turn
  keeps only its latest thinking block. While the next block streams, its
  immediately preceding completed block returns as the expanded previous
  preview, preserving live-turn context without leaving two completed cards
  behind. A block restored by expanding its ordinary activity summary is not
  duplicated in the preview. Preview text participates in the projected search
  scope. The row packs the activity summary and available previews together
  whenever their measured target widths fit, then wraps whole cards when they
  do not.
- The activity list and the superseded *previous* thinking preview each cap
  their height to the current/latest preview's rendered content height, measured
  and published on the row as `--conversation-thinking-height`. Neither sibling
  may claim more vertical space than the current thinking block requests, and
  the previous preview's height is `min(natural, current)`, growing with the
  current block as it streams. Because the current block thus owns the row
  height, the previous preview disappearing at turn completion causes no
  shrink — and so no main-conversation autofollow flicker. The same cap covers
  the activity names, which shorten at turn completion as the bound below moves
  to the newly completed block.
- **The row keeps its high-water height for a cooling-off period.** The cap
  above stops the row growing past the current thinking block, but says nothing
  about shrinking: a long streamed block followed by a short one hands the
  height straight back, and under follow mode that drags the passage the reader
  is on down the viewport. So the row claims its tallest measured height as a
  `min-height` and gives it up only after wanting less continuously for
  `CONVERSATION_ACTIVITY_RESERVE_HOLD_MS` (30s). The hold is anchored at the
  moment content *first* fell below the reserve, so content that grows back
  into the reserve restarts the wait rather than spending it — a turn that
  alternates thinking and activity never releases mid-stream. Policy lives in
  `packages/client/src/lib/sessionDetail/activityHeightReserve.ts` as a pure
  reducer; `RenderItemComponent` publishes the result on the row as
  `--conversation-activity-reserved-height` and a `ResizeObserver` re-measures.
  Two invariants make it safe:
  - **Measure the children, never the row.** The reserve is applied to the
    row's own box, so measuring that box would feed the reserve back into
    itself and the row could never shrink. The natural height is the greatest
    child bottom relative to the row's top. For the same reason the observer
    watches the children as well as the row: while the reserve holds, the row's
    box is pinned, and only a child's resize reveals that content wants less.
  - **Reader gestures release it at once.** Collapsing a card (chevron) or
    dismissing the last card — which hides thinking entirely — is a request for
    the space back, so the reserve resets instead of leaving a 30s hole.
    Dismissing a non-final card gets no special handling: under rapid
    alternation a dismissal would not have saved the space anyway.
- A thinking card carries its **placement in the turn** beside its controls:
  how far before the turn's end that block last spoke, in the same compact
  form as the activity summary's elapsed time (`4.7s ago` against a
  `34s · 8 activities hidden` summary). This is placement, not duration — the
  summary already says how long the turn took, and this says where in that
  span the thought happened. The turn's end is the reference, which is the
  live clock while the turn runs, so the age advances on an active turn.
  A streaming block gets none: it is happening now. Sub-second ages are
  omitted, since the pulsing dot already carries recency at that scale, and a
  block whose provider gave no timestamps shows none rather than inventing
  one — the same rule the activity summary follows.
  The card label is what yields when the header is tight; the age and controls
  are fixed-size and carry state.
- Each thinking-preview slot can be collapsed or dismissed independently.
  Streaming updates to the block occupying a slot do not reopen a collapsed
  card. Dismissing the final visible card switches the thinking-transcript
  control off; switching that control on again restores both available cards
  expanded. Scrolling an expanded preview away from its live edge pauses
  follow for that logical block while it grows; when a new block replaces it
  in the same slot, that new block starts at its own live edge. A lone remaining
  card may use the width released by its dismissed peer.
- When at least one thinking preview is expanded, the activity column may show
  concrete activity kinds below its count. The visible count is decided by
  layout, not a fixed number: the list is newest-first and fills the height the
  current thinking block requests, so a short thinking block shows few names and
  a tall one shows more. The newest row stays whole at the top; when the list
  overflows, the oldest rows clip at the bottom behind a fade rather than a hard
  cut. File operations may add a basename and commands may add a bounded
  description or verb-first command fragment. These previews remain whole single
  lines and may truncate; by default they cannot widen the activity column. The
  complete ordinary tool summary remains available as a tooltip.
  Because the names cap to the current/latest card's rendered height, collapsing
  that card clips them away; they never reserve vertical space.
- **The last complete thinking block bounds the list.** The names answer "what
  has happened since the thought I just read", so only activities after that
  block are named; everything earlier is already accounted for by the thought
  and stays folded into the count. The bound is deliberately the last
  *complete* block rather than the last block: while a new one streams the
  reader is still working out of the previous completed thought, so the
  activities that thought led to must remain visible rather than vanishing the
  moment new thinking begins.
  The bound is global rather than per-turn, so a turn that did no thinking of
  its own still measures from the thought the reader last saw. With no complete
  thinking block anywhere, nothing bounds the list and every activity in the
  turn qualifies; with no thinking at all there is no preview to attach to, so
  the turn shows only its count.
  Turn completion does **not** clear the names — an earlier revision hid them
  at turn end, which discarded exactly the activities the reader had not yet
  accounted for. Because the names cap to the current/latest card's height, a
  finished turn keeping them cannot grow the row.
- **Appearance → Wider activity previews** is a browser-local, default-off
  option included in browser-settings backup. In Conversation view it lets the
  activity column consume otherwise unused inline space and aligns thinking
  cards to the trailing edge, exposing more of long command and file previews.
  The rounded activity summary remains intrinsic-width. Thinking-card target
  widths, wrapping, height caps, and complete-summary tooltips do not change.
- A thinking card begins at a compact target width. Its target may grow as the
  same thinking block streams but never shrinks until that slot receives a new
  block; the card may then reset to a narrower measured target. Targets remain
  clamped by the card and row bounds. This per-block hysteresis avoids
  paragraph-by-paragraph layout oscillation without retaining a cross-turn
  moving average.
- Standalone bold lines that the thinking renderer recognizes as Codex outline
  headings use a smaller, lighter subhead treatment than ordinary Markdown
  headings. The treatment belongs to the shared thinking renderer, so it is
  identical in transcript expansion and Conversation previews without
  rewriting the source Markdown.
- Public session shares are the explicit default-state exception. Their
  independent read-only shell starts in Conversation view and exposes a compact
  floating icon toggle regardless of the owner's toolbar customization or last
  local mode. Owner and public views call the same window and conversation
  projection, so later visibility rules—such as meaningful documentation
  edits—take effect in both places.
- Live public shares use the normal session viewport's follow machinery.
  Incoming output follows while the viewer remains at the live edge (including
  its near-bottom continuation band); scrolling away preserves the reading
  position and adds **Follow** to the floating control cluster. Frozen shares
  show the Conversation toggle but no Follow action.

## Time and count semantics

The duration is an **elapsed activity span**, never CPU time, focused-work time,
or billing time. It starts at the earliest source-message timestamp among the
activities represented by the summary, so an older compact-history or other
retained turn-boundary row cannot inflate the result. For a completed assistant
turn it ends at the latest observed source-message timestamp in that turn. While
the latest assistant turn is active, its end is the current client clock.

The count is the number of activities hidden by this view. A tool parent counts
its ordered semantic display actions when the provider projection supplies
them; otherwise each hidden render item counts once. Media and retained
failure rows are not included because they are still visible.

## Deferred: meaningful documentation prose

There is a plausible middle ground between hiding every edit and showing raw
code-edit machinery: a documentation edit authored by the agent can itself be
conversation-relevant prose. This is deliberately **not v1 behavior** because a
filename or tool name alone cannot reliably distinguish prose from generated,
mechanical, or code-like changes.

A future implementation should prefer a compact `document name + bounded added
prose` card, with the whole edit block available only on expansion. It may emit
that card only when all of these are true:

- the target is classified as documentation by a conservative path/type policy
  (for example Markdown or another explicitly registered prose format), not
  merely because the filename happens to contain `doc`;
- the provider/compiler supplies trustworthy structured edit hunks and target
  paths, rather than YA scraping terminal output or rendered DOM;
- added lines are predominantly prose and fit a bounded excerpt after removing
  diff markers; code fences, generated sections, bulk formatting, vendored
  text, and large mechanical rewrites fail closed;
- the excerpt is agent-authored addition, not surrounding source context,
  deleted text, command output, or user-authored content.

When a doc edit is meaningful but no safe excerpt can be derived, the compact
form may say `Document edited: <name>`. Open questions are the excerpt bound,
whether multiple doc hunks form one card, and how to mark mixed prose/code
documents. Images remain ordinary visible media associated with the turn; this
extension must not absorb them into edit summaries.

## Implementation boundary

The history-window projection and `projectConversationView` run after the
stable provider transcript projection and before turn grouping, timeline rows,
search, and React rendering. The window selects a user-turn-aligned suffix;
`projectConversationView` then adds a synthetic `conversation_activity` render
item rather than hiding DOM nodes. This keeps owner/public behavior, ordering,
media retention, search scope, progressive rendering, and scroll anchoring
attached to the same render-item model as the full transcript.

**Grow within a block, reset between blocks** (vs. an exponential moving
average over recent blocks): a complete thinking turn is normally only a few
seconds, so an occasional reset/reflow is acceptable. Slot-local monotonic
growth gives stable streaming layout while letting two later compact blocks
return to one row promptly.
