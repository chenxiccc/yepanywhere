# Client Summary Store Close-Out

Status: Tracking.

This is the active close-out tracker for the client summary store series. The
initial store build, source registry, and draft source-scoping work are
complete. The remaining work should be deliberately small: finish consistency
gaps around shared summary mutations, add narrow selectors where they remove
real coupling, and avoid pulling live session/process state into the store just
because it is visible in more than one place.

Historical setup docs:

- [`025-zustand-client-summary-store.md`](025-zustand-client-summary-store.md)
  covers the Zustand substrate and completed slice migrations.
- [`026-client-summary-long-tail.md`](026-client-summary-long-tail.md) is
  closed. Its broad migration checklist has been distilled into this doc.
- [`027-client-summary-source-registry.md`](027-client-summary-source-registry.md)
  covers the per-source registry and source-scoped draft/handoff storage.
- [`031-client-query-controller.md`](031-client-query-controller.md) tracks the
  proposed shared fetch/query lifecycle layer for summary feeds, starting with
  Sidebar/global-session coverage.

## Boundary

`clientSummaryStore` is the current-source normalized cache for shared summary
facts. It owns facts that multiple surfaces render or compose:

- session summary rows and query membership;
- project summary rows and project-list membership;
- inbox tier membership and derived active/attention counts;
- project queue summaries and targeted-session ids;
- lightweight local decorations such as draft presence;
- source-scoped browser handoff/decorator facts that affect shared cards.

Feed/action hooks own lifecycle:

- connection readiness and current source capture;
- REST requests, loading, error, pagination, mutation-in-flight state;
- request start timestamps and stale-response protection;
- reporting accepted snapshots and successful mutations into the store.

Keep out of the summary store:

- full session messages and provider transcript payloads;
- streaming transcript deltas and rendered transcript bodies;
- current session ownership/liveness/pending-input state used only by the
  mounted session page;
- process-supervisor row lists unless another surface needs to compose them;
- composer text, attachments, upload progress, and page-local UI state;
- global browser UI preferences that are intentionally shared across hosts.

## Current Surface Audit

| Surface | Status | Notes |
| --- | --- | --- |
| Sidebar session rows | Done | Feed hooks keep queries warm; rows and badges render from store selectors. |
| Sidebar inbox, queue, and draft badges | Done | Inbox counts, queued session ids, and draft ids are store selectors. |
| All Sessions rows | Done | `useGlobalSessionsFeed` owns lifecycle; rows render from `useSessionCollectionQueryRecords`. |
| All Sessions stats/filter options | Keep local | Stats and project filter options are page controls, not shared rows. |
| Session switcher dropdown | Done | Uses global-session feed plus store query records. |
| Inbox rows/counts/badges | Done | Compatibility context still exists, but rows/counts are store-selected. |
| Projects page rows | Done | `useProjects` reports snapshots; page renders store project records. |
| Projects page inbox counts | Done | Uses `useInboxCountsByProject()`. |
| Projects page queue counts | Cleanup candidate | Queue data is store-backed through `useProjectQueues`; direct count selectors would reduce coupling. |
| New Session project chooser | Triggered follow-up | Project rows and active-session ids are store-backed, but the 2026-08-05 probe found that choosing a recent project waits on up to 30 sequential provider-aware session summaries. Tactical 095 owns the narrow recent-project projection. |
| New Session queue button | Good enough | Store-backed project/queue/active facts plus local form selection. |
| Session page transcript | Keep local | `useSession` and `useSessionMessages` own heavy live state. |
| Session page detail/process modal | Keep local | Driven by `useSession` state plus on-demand `getProcessInfo`. |
| Session page queue affordance | Good enough | Store-backed project/queue/active facts plus local live session blocking state. |
| Agents nav badge | Done | Reads active count from summary selectors. |
| Agents page process rows | Maybe later | `useProcesses` polling is acceptable until another surface needs the same process rows. |
| Settings pages/hooks | Maybe later | Consider a settings slice only if settings drift or duplicated fetches become visible. |

## Highest-Value Remaining Work

### Shared Session Mutation Helpers

Priority: High.

Several surfaces still call metadata/read APIs directly:

- `SessionListItem`;
- `GlobalSessionsPage` bulk actions;
- `SessionPage` title/star/archive/read actions;
- `useEngagementTracking`;
- session heartbeat/recap settings surfaces that update session metadata.

Add a small client action module that:

- captures the current `ClientSummarySourceKey` at call time;
- calls the existing API method;
- reports the accepted mutation into `clientSummaryStore`;
- keeps UI-specific optimistic state local where a page already needs it;
- exposes focused helpers such as `updateSessionMetadataAndReport`,
  `markSessionSeenAndReport`, and `markSessionUnreadAndReport`.

Acceptance:

- a successful star/archive/title/read mutation updates every mounted summary
  surface for the same source without waiting for a later REST snapshot;
- late or cross-source mutation responses write only to their captured source;
- direct API calls remain only where no summary fact changes.

### Project Queue Selector Cleanup

Priority: Medium.

`useProjectQueues(projectIds)` is already store-backed: it fetches/mutates queue
state and returns items selected from `clientSummaryStore`. Some surfaces still
derive display facts from the hook return shape.

Useful selector additions:

- queue item count by project;
- visible or blocking queue item count by project;
- queue items for one project;
- queue items targeting one session;
- boolean queue presence for one session.

Acceptance:

- card/list surfaces use purpose selectors for badges/counts;
- `useProjectQueues` remains the feed/mutation owner;
- no behavior change to queue fetch cadence or mutation controls.

### Project Add/Delete Reporting

Priority: Medium-low.

`ProjectsPage` currently refetches after add/delete. That is correct but less
immediate than local reporting.

Consider shared project action helpers when this becomes visible:

- `addProjectAndReport`;
- `deleteProjectAndReport`;
- successful project metadata updates if more project mutations are added.

Acceptance:

- successful add/delete updates project selectors for the captured source;
- refetch remains as a safety net where server responses do not include enough
  project-list context.

## Maybe Later

### Agents Processes Slice

Leave `useProcesses` local for now. Process rows are supervisor/runtime state,
not the same thing as session summary rows. Add a separate `processes` slice
only if process rows need to compose with Sidebar, Projects, Session Page, or
notifications beyond the current active-agent count.

### Settings Slice

Settings and client defaults are shared and consistency-sensitive, but they
change slowly. A store slice may be useful if multiple settings surfaces start
duplicating fetch/mutation logic or if cross-tab/settings drift becomes a real
bug. Until then, existing settings hooks are acceptable.

### Recent Visits Slice

Recent visits could become an ordered membership slice composed with session and
project records. Keep it low priority unless New Session recent rows diverge
from summary records or more surfaces need the same recent-visit projection.

### Permission-Mode Browser Storage

`permission-mode-<sessionId>` remains keyed by session id. This is lower risk
than drafts and may be acceptable as browser-local user intent. Source-scope it
only if same-id host switching produces a concrete bug.

## Do Not Migrate

Do not move these into `clientSummaryStore` as part of close-out work:

- session transcripts or rendered message bodies;
- streaming markdown/augment state;
- process detail modal state;
- current session liveness and pending input that only the mounted session page
  consumes;
- per-page filters, selection, expansion, and scroll state;
- global UI preferences such as theme, font size, sidebar layout, and renderer
  preferences.

## Verification Checklist

For any close-out change:

- switch hosted remotes in one tab and verify previous-host rows do not appear;
- verify successful local mutations update every mounted summary surface for the
  same host;
- verify late responses write to the request source, not the current source;
- keep focused unit/component coverage near the migrated surface;
- do not broaden the store boundary unless a second real consumer needs the
  same fact.
