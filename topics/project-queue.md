# Project Queue

> Project Queue is a durable, server-owned backlog for work that should start
> only after a whole project becomes quiet.

Topic: project-queue

It is project-scoped, not global across the YA install, and it is separate from
the existing per-session queue.

This topic describes the current single-lane model: one project checkout is
treated as the scheduling unit. [`workstreams.md`](workstreams.md) describes
a proposed lane-aware extension where Project Queue items can target a
specific lane — the canonical main checkout or a separate lane checkout —
instead of waiting for the whole project.

## Core Semantics

- Project Queue items are persisted on the server. Clients must not mirror the
  queue in localStorage or hold invisible scheduled sends.
- Queue targets are either an existing YA session id or a future new session in
  a project. A provider with an authoritative catalog is revalidated at actual
  new-session process creation; enqueue-time UI validation cannot remain launch
  authority across an arbitrary queue delay. If promotion hands a new session
  to the internal worker queue, the durable item stays `dispatching` until that
  worker launch settles. Successful start removes it. Authoritative validation
  or a non-retryable launch failure moves it to `failed` with the reason,
  preserving the prompt for retry. A transient provider-startup failure before
  the provider reports its canonical session id returns the same item to the
  head of its project queue. The third consecutive startup failure pauses that
  item as `failed`; Retry resets its startup-failure count. This item-local
  pause does not set the global dispatch pause, although a failed head item
  continues to block later work in that project by ordinary queue ordering.
  A direct Gateway caller without this durable settlement channel receives the
  existing `queue_full` response at worker capacity instead of an acceptance
  whose deferred validation failure it cannot observe.
- Delivery never rewrites user text with hidden prompt framing, elapsed-time
  markers, or automatic anchors.
- A normal session queue is lower-level than Project Queue. Existing in-turn
  work, direct provider queue depth, deferred queue depth, pending input, and
  retained provider work must all drain before a Project Queue item promotes.
- Project Queue promotion requires the project to remain idle for the configured
  project-quiet window, then re-checks project idleness immediately after
  claiming the item.
- An admitted user request to start or reactivate a session reserves that
  project as busy before provider startup begins. The reservation remains until
  the provider harness has successfully started or the request reaches a
  settled failure, closing the gap before the new process appears in the
  ordinary idle predicate.
- Promotion handles one Project Queue item per project-idle boundary. Do not
  drain the project backlog in one burst.
- A global Project Queue dispatch pause gates automatic promotion above all
  project items. A valid action that mutates or dispatches an existing item
  (edit/save, delete/cancel, retry, reorder, Start/Force start, or Steer now)
  resumes dispatch globally before completing that action. Read-only actions
  such as Copy do not resume dispatch.
- A server restart with persisted Project Queue backlog starts
  paused-after-restart by default. After inspecting any work that may have been
  interrupted by the restart, the user can use Resume or act on an item; either
  path resumes dispatch.
- Dev-mode scheduled safe restart also pauses Project Queue dispatch before
  waiting for active sessions and in-memory session queued messages, including
  per-process direct/short-term deferred queues, to drain. Live patient
  session-queue entries are preserved as restart-paused work once those
  volatile blockers have drained. The durable Project Queue backlog survives
  the restart and remains visibly paused until the user resumes it. Persisted
  recovered patient session-queue entries are reported as preserved work in
  safe-restart status rather than as drain blockers, but they still count as
  project-busy for Project Queue promotion so project-level work cannot jump
  ahead of restart-paused per-session work.
- Empty Project Queue state is always normal/running. Do not preserve a hidden
  pause after the last queued/failed/dispatching item leaves the queue.

The intended ordering is:

1. Active provider turn.
2. Per-session direct queue.
3. Per-session deferred/patient queue according to its own rules.
4. Verified project idle.
5. One Project Queue item.

This means a session with five normal queued messages should finish those
messages before Project Queue starts. Project Queue is not a competing second
queue on the same session; it is a project-level backlog that injects only
after all lower-level work in the project is done.

## Quiet Window

Project Queue's quiet window is a user-interaction patience setting, not a
replacement for the idle predicate. Per-session direct/deferred/patient queues,
pending input, active provider turns, retained provider work, worker queue
entries, and known external ownership still block Project Queue absolutely.
Once those blockers clear, the project must stay clear for the quiet window
before one Project Queue item may promote.

Queue status must be server-computed. Project Queue responses expose each
project's scheduler state (`blocked`, `waiting-quiet`, `ready`, `dispatching`,
`paused`, or `empty`), the configured quiet window, the next eligible timestamp,
and raw blocker strings. The client may format that state as "waiting for quiet"
or "blocked by ..." copy, but it must not infer idleness from stale local
session rows.

Blocked automatic attempts must stay live. If a quiet-window timer fires while
absolute blockers remain, the scheduler keeps a bounded retry armed while
backlog remains so decaying liveness or external-ownership evidence cannot leave
the Project Queue inert forever.

Queue collection reads are retained projections, not provider discovery
triggers. Existing-session titles come from the
[`compact session catalog`](session-catalog-observation.md) plus immediate YA
metadata; unresolved titles remain nullable while one exact background repair
runs. Repeated queue reads with unchanged state perform no provider,
session-index miss, transcript, or all-project work.

Item, dispatch, blocker, quiet-window, external-ownership, and recovery
transitions update one server-owned project-status projection and publish a
versioned delta. Client components share one source/query revalidation owner.
They render countdowns from server timestamps and may arm one exact
source-level deadline or capability-gated legacy poll; they never each start a
fixed interval. An event that lacks title fields must merge as a partial patch
and cannot erase a known catalog-backed title.

The configurable range is 0-300 seconds, default 30 seconds. A value of 0 means
"promote as soon as the project idle predicate is true", while still performing
the immediate post-claim idle re-check. The effective minimum is therefore the
time required for lower-level queues to actually drain plus the configured
Project Queue quiet window; Project Queue must not rely on the patient-queue
safety margin as its only protection against launching too early.

## Project Idle Predicate

A project is not idle while any owned session in that project has:

- active `in-turn` or `waiting-input` state;
- retained provider work while otherwise idle;
- direct provider queue depth greater than zero;
- deferred queue depth greater than zero;
- pending input;
- liveness other than `verified-idle`.

A session whose user has queued `/done` is exempt from all of the above for
Project Queue promotion. The user has declared that session finished, so the
final action the agent is still completing is not backlog the next queued
request should wait behind, and the queued `/done` chip itself must not read as
a deferred-queue blocker. The exemption is Project Queue's alone: the
inactivity push notifier reports whether work is literally still running and
therefore keeps counting that session.

A project is also not idle while it has a worker/startup queue entry or known
external session ownership. It is likewise not idle while an admitted
user-initiated session start is still establishing its provider harness.
Project Queue promotion also treats persisted
`paused-after-restart` patient session-queue entries in the project as
not-idle, even when no live process currently owns those entries. External
ownership is best-effort and can decay; UI copy must not promise perfect
detection of all outside provider activity.

## UI Semantics

The toolbar affordances are YA-novel behavior, so both are hidden/default-off
unless the user opts into them. The current-session Project Queue button and
the active-composer `+` shortcut for a future new session have separate
presence settings. Enabling the current-session action must not implicitly
enable the cross-session shortcut.

The two toolbar actions must remain glanceably distinct wherever they render,
including the ordinary composer, compact keyboard-open row, and Toolbar
Settings specimen. The current-session action uses the standard Project Queue
purple. The new-session action uses a darker violet and a prominent
high-contrast `+` badge; the small mark must not be the only perceptible
difference between two otherwise identical buttons.

Project Queue UI must also be capability-gated on `/api/version` advertising
`projectQueue`. The active-composer new-session shortcut and its Toolbar
setting additionally require
`project-queue-new-session-shortcut-setting`, so newer clients do not save the
new presence key to older servers that reject it. Treat missing capabilities
as unsupported so newer remote clients do not show Project Queue entry points
against older servers.
Hosted remote clients must additionally require the current remote
compatibility generation, because early Project Queue-capable source checkouts
predate the compatibility marker and can expose partial Project Queue behavior
to newer hosted clients.

After restart-paused dispatch, each queued new-session row in the sidebar's
Pending Sessions section exposes a compact Resume control. It atomically
resumes global dispatch and moves that item to the head of its own project's
queue. The ordinary scheduler still decides when it may launch; Resume is not
Force start. Failed items retain their explicit Retry flow instead.

When the button is visible by user preference, the UI should still suppress it
when Project Queue adds no useful semantics:

- Hide when the project is fully idle, has no Project Queue backlog, and normal
  send/start is equivalent.
- Hide when the only active thing is the current session and it has no
  server-visible normal queued/deferred backlog; normal queue is enough.
- Show when the current session already has normal queued/deferred work,
  because Project Queue then means "after this session backlog drains."
- Show when any other session, external session, or worker queue entry in the
  project is active.
- Show when the project already has Project Queue backlog, so a normal send or
  start does not accidentally jump ahead of accepted queued project work.

The dedicated new-session form follows the same rule: hide its Project Queue
action when the selected project is idle and has no Project Queue backlog; show
it when the project has active work or existing Project Queue backlog. Its
entry point remains governed by the ordinary Project Queue presence setting.
Independently of that action preference, the form shows any existing items for
the selected project directly below the project selector. The selector and
queue are one responsive layout unit: they remain in the same side column on a
wide form and move together ahead of provider controls on a narrow form. A
project change replaces the displayed items in place. An empty queue remains
hidden after a successful read, so users who have not invoked this default-off
feature do not encounter a new empty-state concept. An initial read failure is
still rendered even when no stale items exist; failure must not masquerade as a
confirmed empty queue.
An active session composer's additional "queue as new session" action has
useful semantics even while the project is idle, but it is present only when
the separate `projectQueueNewSessionShortcut` toolbar control is enabled and
supported. The neighboring current-session Project Queue action retains the
activity/backlog visibility rule above.

The new-session initial-turn composer is part of the Project Queue contract.
When it queues a new session, the durable prompt/copy source is the text
accepted from that composer, because that is what the user typed (including
slash-command arguments). The promoted session should persist that text as its
initial prompt and derive its title/display fallback from that saved prompt.
Both the dedicated new-session form and the active-session composer's
additional new-session action create the same durable Project Queue target
shape (`target.type === "new-session"`); neither uses a client-held draft
queue. The active-session action inherits that session's selected provider,
model, executor, permission mode, and thinking settings for the future session.

Current-session Project Queue action visibility should use both exact active
session ids, when available, and project-level Project Queue blocking-count
summaries. The count fallback covers cases such as a fresh client after server
restart where a project has queue-blocking work but the current session
composer has not yet seen every active sibling session in its local inbox
tiers. Do not derive this fallback from owned-process counts alone; idle
retained YA processes should not expose the current-session action.

When the current-session Project Queue action is visible and the Project Queue
Ctrl+Enter preference is enabled, Ctrl+Enter activates that same
current-session action instead of the regular per-session alternate action. In
the dedicated new-session form, Ctrl+Enter activates that form's new-session
Project Queue action. It does not activate the active-session composer's
additional new-session action. Each binding is intentionally conditioned on
the availability of the button it mirrors, so hiding or disabling Project
Queue cannot silently steal Ctrl+Enter from regular queue/steer behavior.

### Deferred startup-incident presentation

The basic surface is deliberately small: a project card shows a separate
warning badge in addition to its queue count whenever that project has a
`failed` item, and the existing Project Queue row carries the error and Retry
action. The badge is attention state, not another count. Automatic startup
attempts do not produce repeated browser toasts.

Field observation on 2026-08-09 confirmed this settled state after a real
post-restart retry: the item retained its prompt and startup-timeout detail,
rendered `Failed` with Retry/Edit/Delete actions, and kept only its own project
blocked as `Blocked: first queue item failed`. A later full YA reload made the
preceding dirty-server state unsuitable for exact reproduction; it is not
evidence for expanding the incident UI.

A richer state-apparent presentation is worthwhile only if field evidence says
this intermittent edge case is common enough to justify it. A future design
could keep the project card badge stable while expanding the queue row into a
compact incident summary: `startup attempt 2 of 3`, last-attempt time, next
automatic-attempt time, provider/runtime identity, and the last distinct error.
On the third failure it would switch in place to `Paused after 3 startup
failures` with Retry, Edit, Copy, and diagnostic-detail actions. The detail
view could retain the three timestamped errors and whether each failure
happened before provider session identity, making transient host trouble easy
to distinguish from an item-specific launch configuration or provider
rejection. It should remain item-local and avoid a modal, global banner, or
global Project Queue pause.

## Inline Rendering

Session views should render Project Queue items that target the current session
inline near the existing queued-message UI. Use the Project Queue purple action
color, not the normal per-session queue color. Each inline item should display
its Project Queue position within the project backlog so users can distinguish
local session queue order from project-wide queue order.

Inline rendering reuses the current-session queued-message actions for items
that target that session:

- Copy preserves the queued text.
- Edit is available only while the main composer has no text, attachments, or
  uploads. It atomically removes the item from Project Queue and restores its
  text, uploaded attachments, and permission mode into the composer. It is a
  take-to-composer action, not a second in-place queue editor.
- Steer now force-dispatches that item to the existing session with explicit
  steering intent, bypassing quiet/idle blockers and implicitly resuming global
  dispatch first, but not bypassing the per-project in-flight guard.
- Cancel removes the item from the inline queue.
- Resume is shown inline while global dispatch is paused. It resumes dispatch
  without otherwise changing the item.

There is no promote-to-patient action. Patient queue remains a per-session
delivery intent rather than another Project Queue state. The projects page
remains the authoritative queue manager for cross-project inspection, full
in-place edit, retry, and reordering.

An item whose attachments still exist only as Project Queue-owned staged
references cannot be taken into the session composer: removing that item also
cleans those staged files. Keep Edit hidden for that case rather than silently
dropping attachments. Existing-session items normally carry durable uploaded
attachment references and can restore them.

### Future inline editing

The take-to-composer action is intentionally only an incremental editing
affordance. A future inline editor should replace the queued row with a
textarea that grows and reflows the queued-message stack as lines are added,
while preserving the row's project-wide position. It must acquire a
server-visible edit hold before exposing mutable text: otherwise the scheduler
can dispatch the original item while its client-side editor is open. Save
patches the same held item and releases it; cancel restores the original item
and releases it. The shared rationale and interaction contract are in
[`edit-turn.md`](edit-turn.md).

The projects page is also the authoritative global dispatch pause surface. Show
Pause/Resume only while Project Queue has visible backlog. When dispatch is
paused after server restart, copy must distinguish that state from a manual
pause so users understand why durable backlog is not promoting automatically.
While paused, show Resume both in the section header and on each item so the
recovery action is available at the point of work. Any valid item mutation or
dispatch action is also an implicit global Resume.
The projects-page queue manager uses Delete/Remove wording for permanent item
removal. The session-inline queued-message surface uses Cancel, matching the
neighboring per-session queue action even though both remove the persisted
Project Queue item.

Move-to-top is project-local, but invoking it while dispatch is paused resumes
the global dispatcher before applying the project-local reorder.

Each item on the projects page may offer a Start now control. Start now skips
only the remaining quiet-window countdown and implicitly resumes global
dispatch; it still refuses when another item is already in flight for that
project or the project idle predicate reports blockers. When blockers remain
visible, the same item may offer an explicit Force start control. Force start
also resumes global dispatch and overrides the idle predicate, but not
per-project in-flight protection; the UI must surface the blockers before
making that override available.

When recovered `paused-after-restart` patient session-queue entries exist, the
projects page shows them above Project Queue items because they run first and
block Project Queue promotion. Each recovered row offers Resume and Delete
through the existing session-scoped routes. Resume keeps the established
resume-through ordering, while Delete removes only the selected durable id; the
row remains until a server-confirmed collection read removes it. The session
link remains the surface for full context and Steer now. There is no
project-wide Resume all action.

## Attachments

Existing-session Project Queue items may contain already uploaded attachment
references because the session id and upload destination exist at compose time.

New-session Project Queue items support attachments through the server-owned
pre-session staging area. The queue persists only staged references, not
browser `File` objects, blob URLs, or in-flight upload handles. Promotion
materializes those staged files into the new session's normal attachment
destination. The design and lifecycle are documented in
`docs/tactical/028-pre-session-attachment-staging.md`.
