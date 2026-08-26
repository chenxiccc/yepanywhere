# Session Scroll Memory Policy

Date: 2026-07-03

Status: device-specific cursor implemented

See also:
[`topics/client-route-retention.md`](../../topics/client-route-retention.md)
§ Contract: Coming Back To Where You Left Off — the restore contract these
policy modes serve.

## Motivation

Session detail scroll state has two lifetimes: exact DOM pixel geometry is an
in-tab warm-restore hint, while the furthest seen turn/activity anchor and
follow state are a device-specific high-water mark persisted in site storage.
Before these slices, both concepts were mixed into the session detail reducer
state, which made ownership hard to reason about:

- reducer state carries transcript/session data and scroll metadata together;
- `MessageList` owns the actual DOM geometry and follow-tail mechanics;
- a bottom-position snapshot means "follow the newest tail on return", while a
  scrolled-back snapshot means "restore this viewed row";
- the user preference is implicit in restore code instead of named as policy.

The goal is to make those concepts explicit without changing the default
provider-like behavior.

## Decisions

- Browser-local policy lives in `localStorage` under `UI_KEYS`, alongside the
  existing performance settings.
- Each source/project/session has a separate site-storage high-water mark. Tabs
  may update it concurrently; there is no lease or exclusive writer. The
  furthest turn seen by any visible tab wins, including an active turn that has
  not completed. Within that turn, expanded view advances to the furthest seen
  activity and content offset. Scrolling upward never lowers either frontier.
  Two visible sessions do not interfere and two tabs on one session converge
  on the same maximum.
- Each snapshot records whether its winning tab was following. `live-tail`
  uses that bit on restore; `remember-place` restores the high-water anchor.
  Conversation View needs the winning turn; expanded view retains the specific
  activity location. Both are device-specific, not server-shared read state.
- Per-session scroll memory belongs to the session detail cache entry, not the
  reducer-owned `SessionDetailState`.
- `MessageList` remains responsible for live DOM scroll physics:
  programmatic-scroll suppression, ResizeObserver catch-up, user scroll intent,
  and follow-button behavior.
- The default mode is `live-tail`: a cursor recorded while following reopens at
  the current bottom and keeps following; a parked cursor restores its anchor.
- The policy remains an advanced Development setting while the non-default mode
  names settle. It is a normal searchable row: an advanced setting must not be
  collapsed or excluded from Settings search when users need to refind it.
- The control's purpose is to make scroll bug reports explicit about the active
  restore expectation while also providing the `remember-place` recovery
  preference.

## Policy Modes

- `live-tail`: provider-like default. Restore a cursor recorded while following
  to the newest bottom and follow. Restore a parked cursor to its
  anchor/geometry.
- `remember-place`: restore the furthest-seen anchor when available, including
  snapshots captured while the user was at bottom. Reviewing earlier content
  does not move the return point backward. This makes "new output while away"
  visible below the restored viewport instead of jumping past it.
- `no-memory`: do not retain or restore per-session scroll snapshots. Transcript
  cache may still retain message data. Selecting this mode clears the
  device-specific cursors.

## Implementation Tracking

- [x] Add a tactical plan for scroll memory policy and storage ownership.
- [x] Add a browser-local scroll behavior policy key and hook plumbing.
- [x] Move retained scroll snapshots out of `SessionDetailState` and into the
  cache entry metadata boundary.
- [x] Capture anchors even when the viewport is at bottom; default live-tail
  restore still ignores that anchor for bottom snapshots.
- [x] Route initial restore through a named policy decision.
- [x] Prevent resize handling from re-arming follow mode from near-bottom
  geometry.
- [x] Add focused tests for policy parsing, cache-owned scroll memory, and
  remember-place restore.
- [x] Retry anchored `remember-place` restore while progressive hydration is
  still mounting older rows.
- [x] Show a "new output below" follow affordance when `remember-place`
  restores a previously-bottom viewport above newer output.
- [x] Capture anchor neighbor/timestamp context and use exact anchor,
  neighboring row, nearest timestamped row, then raw `scrollTop` as the restore
  fallback order.
- [x] Suppress scroll snapshot writes while progressive hydration is active and
  publish one settled snapshot after the reveal completes.
- [x] Expose the policy as a visible, searchable Development setting so
  maintainers can ask which restore mode was active during scroll reports.
- [x] Publish a visible following tab's position when a whole turn completes,
  even though no user-scroll event occurred.
- [x] Persist settled observations per source/project/session and merge
  concurrent tabs by furthest seen turn/activity without an exclusive writer.
- [x] Advance an active, incomplete turn as soon as it is visible; retain its
  turn in Conversation View and its specific activity anchor in expanded view.
- [x] Keep the persisted cursor monotone when a reader scrolls upward, including
  within the current high-water turn.
- [x] Retire the behavior-identical `manual-follow` option; legacy stored values
  migrate to `remember-place`.

## Follow-Up Work

- Keep the policy in Development until the behavior names and defaults are
  settled; do not hide it behind a disclosure or exclude it from Settings
  search.
- Add diagnostics for non-exact scroll restores so anchor misses can be counted
  by reason instead of inferred from user reports.
- Tighten fast-stream bottom-follow tests around large bursts and async row
  height changes.
- Add a capability-gated server-shared cursor for cross-device continuity; the
  client-only limitation is tracked in
  [`gaps/server-synced-session-scroll-memory.md`](../../gaps/server-synced-session-scroll-memory.md)
  until that contract lands.
