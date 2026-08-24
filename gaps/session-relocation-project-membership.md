# Relocated live sessions keep their launch-project membership

A live session launched under `draft` was reclassified to `yepanywhere` with
the session's **Move session to project** action. The session page moved, but
two destination-project views remained wrong:

- the sidebar did not regroup the session under `yepanywhere`; and
- active work in the moved session did not block `yepanywhere` Project Queue
  items from promotion.

The move route in `packages/server/src/routes/sessions.ts`
(`PUT /projects/:projectId/sessions/:sessionId/project`) persists a
`workingProjectId` and emits `session-metadata-changed` with the destination
`projectId`. The client collection reducer
`applySessionCollectionMetadataChanged` accepts that project field, but the
observed sidebar remained on the launch-project grouping. The relocation path
therefore does not yet provide a reliable retained session-catalog transition
for every sidebar/query owner.

The Project Queue failure has a separate concrete seam:
`getProjectWorkIdleStatus` in
`packages/server/src/services/projectWorkIdle.ts` filters live supervisor
processes by `process.projectId`. Reclassification changes session metadata,
not the live process's launch project. `ProjectQueueScheduler.handleEvent` also
does not react to `session-metadata-changed`, so it neither recomputes the old
and new project schedules nor has destination-project membership available to
its idle predicate.

Invariant violated: after a session is reclassified, its effective working
project is immediately the single membership used by sidebar/session catalog
grouping and project-level work scheduling. Its provider transcript project
and process launch directory may remain separate facts; neither may continue
to decide destination Project Queue idleness.

The likely repair is one atomic relocation transition that republishes the
retained session collection under the destination project and makes the
project-idle predicate resolve the same effective working project. Scheduler
invalidation must cover both the old and new projects. Regression coverage
should move an active session from project A to B and prove that it immediately
leaves A's sidebar grouping, appears under B, stops blocking A, and blocks B
until its work is genuinely idle.

This is related to, but distinct from,
[`session-transcript-project-from-launch-cwd.md`](session-transcript-project-from-launch-cwd.md):
that gap prevents transcript location from being inferred from launch cwd,
while this one prevents launch cwd from surviving as the effective working
project after an intentional relocation.

It was not fixed while observed because the active implementation request was
paused as WIP and this turn was limited to capturing the defect and the
project-code-name proposal.

Found 2026-08-24 while relocating the paused tab-title WIP session from
`draft` to `yepanywhere`.
