# Inactivity Push Notifications

Status: Push Complete. Desktop notification UX is deferred.

Progress:

- [x] 2026-06-28: Added default-off `projectInactive` and `yaInactive` push
  settings, merged default settings over older persisted
  `push-subscriptions.json` settings on read, accepted the new keys through
  `/api/push/settings`, and added focused service/route tests. No UI toggles
  or notification sends are wired yet.
- [x] 2026-06-28: Added typed `project-inactive` and `ya-inactive` push
  payloads, high-urgency delivery, an event-driven `InactivityPushNotifier`
  with one-shot dirty rechecks, failed Project Queue semantics, connected
  browser suppression, project/YA coalescing, service-worker display/click
  handling, app mounting, and focused tests. Settings UI toggles remain open.
- [x] 2026-06-28: Added Settings -> Notifications toggles and English i18n
  copy for `projectInactive` and `yaInactive`, included both fields in the
  header undo snapshot, and kept the toggles disabled until at least one push
  subscription exists.

## Context

YA already sends push notifications for approval/question attention and, when
enabled, for individual session halt edges. Those events are useful but too
local for the "come back when the worktree is quiet" workflow:

- a session can finish while another session in the same project is still
  active;
- a turn can reach a visible idle boundary while provider-retained background
  work can still wake it;
- Project Queue can promote follow-up work after the apparent idle edge, so the
  real "done for now" moment may be when the project queue empties;
- the whole YA instance can become quiet after several projects drain.

The requested feature is opt-in push notifications for those broader quiet
edges:

1. A project has become inactive.
2. YA has become inactive globally.

This is Web Push-only for the first slice. Web Push reaches subscribed desktop
and mobile browsers; the separate raw in-page desktop notification mechanism
was never part of this delivery path and has since been removed.

Relevant standing contracts:

- [`topics/architecture-mandates.md`](../../topics/architecture-mandates.md)
  - do not add unbounded background work or per-session loops.
- [`topics/project-queue.md`](../../topics/project-queue.md) - project idle
  semantics and Project Queue ordering.
- [`topics/session-liveness.md`](../../topics/session-liveness.md) - only
  verified idle is safe for automatic idle-time decisions.
- [`topics/vanilla-defaults.md`](../../topics/vanilla-defaults.md) - new
  notification behavior is YA-novel and must be configurable/default-off.

## Product Decisions

- Add two server-side push settings:
  - `projectInactive`
  - `yaInactive`
- Both default off.
- Failed Project Queue items do not block inactivity. They will not retry on
  their own, so a project with only failed queue items can be inactive.
- Queued or dispatching Project Queue items do block inactivity because they may
  still run automatically.
- Notification clicks should open a project-level surface, not a session.
  Current implementation opens `/projects?project=<projectId>` for project
  inactivity and `/projects` for YA inactivity; a later UI slice can teach the
  Projects page to visibly highlight that query target.
- Use the same Web Push delivery urgency as existing session notifications.
- Coalesce project and global notifications so one quiet boundary does not send
  both "Project inactive" and "YA inactive" to the same device.
- Do not add a separate raw in-page notification path in this slice. The shared
  Web Push path already reaches desktop and mobile browser subscriptions.

## Current Bearings

Existing push settings and payloads live under `packages/server/src/push/`.
`PushNotifier` currently subscribes to `process-state-changed`,
`process-terminated`, and `session-aborted` events, then sends `pending-input`
or `session-halted` payloads.

Project Queue already has most of the correct project idle predicate in
`ProjectQueueScheduler.getProjectIdleStatus()`. That predicate blocks on:

- active `in-turn` or `waiting-input` process state;
- retained provider work;
- direct queue depth;
- deferred queue depth;
- pending input;
- liveness other than `verified-idle`;
- worker queue entries for the project;
- known external session ownership.

That predicate is intentionally for promotion and ignores Project Queue backlog
itself, because queued Project Queue items are the work to promote. Inactivity
notifications need a related but distinct predicate: queued/dispatching Project
Queue items block final quiet, failed items do not.

Worker activity events already summarize safe-restart facts:

- owned worker count;
- interruptible session count;
- worker queue length;
- `hasActiveWork`.

Those are not sufficient for full inactivity because idle retained processes,
deferred queues, Project Queue backlog, and failed Project Queue behavior all
matter differently from safe restart.

## Definitions

### Project Inactive

A project is inactive when all of these are true after a short quiet recheck:

- no owned process in the project is `in-turn` or `waiting-input`;
- no owned process in the project is retaining provider work;
- no owned process in the project has direct queue depth greater than zero;
- no owned process in the project has deferred queue depth greater than zero;
- no owned process in the project has pending input;
- every owned process in the project reports liveness `verified-idle`;
- no worker/startup queue entry targets the project;
- no known external session owner is active for the project;
- no Project Queue item for the project has status `queued` or `dispatching`.

Failed Project Queue items are intentionally ignored by this predicate.

The edge should only notify after the project was previously active/blocking in
this server lifetime, or after a user action accepted work for that project.
Do not notify on startup just because a project is already quiet.

### YA Inactive

YA is inactive when every known project is project-inactive by the same rules
and there are no global worker/startup queue entries left.

This does not mean the Node process has zero timers, file watchers, or global
maintenance jobs. It means there is no known user-facing or provider-owned work
left to run. Global watchers and fixed-cadence jobs are allowed under the
architecture mandate as long as they are bounded and not per-session loops.

## Server Shape

Add a small event-driven service, tentatively `InactivityPushNotifier`, rather
than growing `PushNotifier` much further.

Inputs:

- `EventBus`
- `PushService`
- `Supervisor`
- `ProjectQueueService`
- `ExternalSessionTracker`, if available
- `ConnectedBrowsersService`, to reuse existing connected-profile suppression

The service should:

- subscribe to the existing EventBus;
- mark affected projects/global state dirty on relevant events;
- run a debounced one-shot recheck for dirty projects;
- keep a small in-memory last-state map for edge detection;
- send push only on active-to-inactive transitions;
- reset the edge when the project/global state becomes active again;
- dispose its subscription and timers cleanly.

Relevant events:

- `process-state-changed`
- `process-terminated`
- `session-aborted`
- `session-status-changed`
- `session-created`
- `session-updated`
- `project-queue-changed`
- `queue-request-added`
- `queue-position-changed`
- `queue-request-removed`
- `worker-activity-changed`

Some events do not name a project (`queue-position-changed`,
`queue-request-removed`, `worker-activity-changed`). For those, recheck all
projects that were active or currently have Project Queue items rather than
starting a full session scan.

Use one-shot timers, not polling. A delay in the 1-2 second range is enough to
let immediate follow-up events settle, including Project Queue promotion and
worker queue handoff.

## Coalescing

Coalescing should happen after the quiet recheck, not before. The preferred
behavior:

1. Gather project inactive edges found in the current debounce batch.
2. Recompute global inactivity.
3. If YA inactive is enabled and the global state just transitioned inactive,
   send only the YA inactive notification for that batch.
4. Otherwise, if project inactive is enabled, send project inactive
   notifications for the project edges in the batch.

This prevents duplicate notifications when the last active project also makes
the whole instance inactive.

If multiple projects become inactive in one batch while YA is still active, the
first implementation may send one notification per project. A later slice can
add a plural "N projects inactive" payload if that proves noisy.

## Push Settings Storage

There are two similarly named files:

- `notifications.json` is owned by `NotificationService` and stores last-seen
  timestamps for unread state.
- `push-subscriptions.json` is owned by `PushService` and stores both push
  subscriptions and the server-side push notification settings.

The settings shape is currently optional inside `push-subscriptions.json`:

```ts
interface SubscriptionState {
  version: number;
  subscriptions: Record<string, StoredSubscription>;
  settings?: NotificationSettings;
}
```

The important compatibility issue: `PushService.getNotificationSettings()`
currently returns `state.settings ?? DEFAULT_NOTIFICATION_SETTINGS`. If a user
already has a persisted `settings` object, adding new keys to
`NotificationSettings` will not automatically populate them in API responses.

For this feature, fix that before adding UI fields:

```ts
getNotificationSettings(): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...this.state.settings,
  };
}
```

Then keep `setNotificationSettings()` persisting the merged full shape. Add a
focused regression test that an older saved settings object such as
`{ toolApproval: true, userQuestion: true, sessionHalted: false }` returns the
new default-off inactivity keys.

Risk level:

- This is not a data-loss danger.
- It is a schema drift issue. Runtime values can be missing even though the
  TypeScript type says they exist, and future default changes would be easy to
  get wrong.
- Merging defaults on read is enough for this slice; a file-version migration
  is optional unless later settings need destructive or semantic migration.

## Payloads

Add payload types. Names can change, but keep project and global separate for
click behavior and service-worker display text.

```ts
interface ProjectInactivePayload extends BasePushPayload {
  type: "project-inactive";
  projectId: UrlProjectId;
  projectName: string;
  failedProjectQueueCount?: number;
}

interface YaInactivePayload extends BasePushPayload {
  type: "ya-inactive";
  projectCount?: number;
}
```

Suggested display copy:

- Project title: project name
- Project body: `Project is inactive`
- Global title: `Yep Anywhere`
- Global body: `All projects are inactive`

Keep body copy short. If failed Project Queue items are present, do not turn the
inactive notification into a retry/error notification in this slice. A count can
be carried in the payload for future UI, but the first copy should stay calm.

## Service Worker Clicks

The service worker currently assumes session notifications and opens a session
when both `sessionId` and `projectId` exist. For project/global inactivity:

- project inactive should open the project-level surface;
- YA inactive should open the main projects page.

Because `/projects/:projectId` currently redirects away from a project-specific
view, the service worker opens `/projects?project=<projectId>`. The query is
currently a durable target hint for the next UI slice rather than a visible
highlight.

Do not open a random last session from the project. The notification means the
project is quiet, not that a specific session needs attention.

## Client Settings UI

Add two toggles to Settings -> Notifications -> Server Notification Types:

- `Project Inactive`
- `YA Inactive`

Both should be disabled when there are no push subscriptions, matching the
existing server-side notification toggles.

Use `useI18n().t(...)` and add English keys in
`packages/client/src/i18n/en.json`. Do not add desktop/browser notification
controls in this slice.

The undo snapshot on `NotificationsSettings` currently enumerates the three
server-side toggles. Add the new fields there when implementing.

## Open Questions

- Should a project with only failed Project Queue items show a quiet push that
  mentions failure count, or should that be reserved for a separate Project
  Queue failure notification?
- Should multiple project inactive edges in one debounce batch get separate
  pushes or a plural summary when YA itself is still active?
- Should the Projects page visibly highlight `?project=<projectId>` from a
  project-inactive click, or is opening the Projects surface enough?

## Implementation Checklist

- [x] Extend `NotificationSettings` with `projectInactive` and `yaInactive`,
      defaulting both to false.
- [x] Merge default push settings with persisted settings on read.
- [x] Extend `/api/push/settings` validation to accept the new keys.
- [x] Add client API/hook fields for the two toggles.
- [x] Add client UI/i18n fields for the two toggles.
- [x] Add push payload types for project and YA inactivity.
- [x] Add service-worker rendering and click handling for the new payloads.
- [x] Add an event-driven inactivity notifier service with one-shot dirty
      rechecks and clean disposal.
- [x] Send to the complete subscribed audience and leave focus/session
      suppression to the receiving service worker.
- [x] Coalesce project and YA inactive notifications in the same debounce
      batch.
- [x] Mount the service from `app.ts` near `PushNotifier`.

## Test Plan

Server:

- persisted old push settings merge in new default-off keys;
- project inactive fires after the last active process becomes verified idle;
- project inactive does not fire while provider retention is present;
- project inactive waits for direct and deferred queues to drain;
- project inactive waits for queued/dispatching Project Queue items;
- failed Project Queue items do not block project inactive;
- external session ownership blocks project inactive until it decays;
- startup with already-idle projects does not notify;
- YA inactive coalesces away the final project's project-inactive push;
- disabled settings suppress sends;
- connected browser profile suppression is preserved.

Client/service worker:

- settings UI reads, toggles, and restores the new fields;
- service worker shows project/global inactivity payloads;
- project payload click opens the project-level surface;
- global payload click opens the Projects page;
- existing pending-input/session-halted behavior is unchanged.

Verification:

- `pnpm lint`
- `pnpm typecheck`
- focused server tests for push/inactivity services
- focused client tests for notification settings and service-worker helpers if
  those helpers are extracted for testability
