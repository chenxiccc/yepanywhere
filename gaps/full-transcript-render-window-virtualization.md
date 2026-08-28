# Full transcript rendering is not bounded to a wakeable window

Conversation View keeps the ordinary live edge small, but switching to the
full activity transcript or using **Load older messages** still mounts every
loaded row in `MessageList`. A live 2026-08-28 semantic-action probe grew from
35 compact rows and roughly 930 DOM elements to 203 full-activity rows and
7,291 elements. One older-page prepend then reached 723 rows, 34,624 elements,
125,117 layout objects, and roughly 527 MiB of JavaScript heap while streaming
continued. The transition produced a 1.27-second long task, a 305 ms
key-to-frame delay, and two independent 10-second control-action timeouts.

Implement **render-window virtualization**, not deferred transcript delivery.
The server and session-detail store should continue receiving the bounded full
message window so reconnect, mode switching, replay, and loaded-history search
retain their current semantics. Conversation View may avoid formatting hidden
detail until needed, but postponing or omitting the underlying activity is not
the first fix: the observed owner is mounted browser structure and the
single large older-page commit, not transfer size.

Use coarse wakeable chunks aligned to semantic turn/activity boundaries:

- mount only chunks intersecting the viewport plus a small overscan;
- replace distant chunks with measured-height placeholders keyed by stable row
  identities, correcting height while preserving the current scroll anchor;
- wake a chunk when scrolling approaches it, search or the turn rail targets
  it, a stored selection/comment anchor must resolve, or the user explicitly
  expands its Conversation View activity;
- preserve disclosure and render-item identity across unmount/remount; and
- derive turn-rail/search offsets from the height model instead of assuming
  every row has a live DOM rectangle.

Before that larger change, split an older-page prepend into bounded semantic
chunks and yield between commits so urgent composer input can run. Preserve the
existing older-page scroll anchor across the whole operation. Re-measure after
this step: proceed to unmounting virtualization only if settled full-history
DOM size or tail latency remains material. Do not revive `content-visibility`;
[`transcript-virtualization`](../topics/transcript-virtualization.md) records
its variable-height scroll failures and the complete coupling checklist.

Acceptance requires that loading the measured long-session page causes no
multi-second task or control-action timeout, ordinary draft typing remains
below the established approximately-100-ms heavy-redraw target during prepend,
and live DOM/layout-object counts are bounded by the render window rather than
the number of loaded rows. Full history, Conversation View switching, bottom
follow, scroll restoration, turn navigation, search, selection/comment
anchors, and explicit activity disclosure must remain behaviorally intact.

Found 2026-08-28 while profiling a live long transcript through the semantic
UI action measurement seam.
