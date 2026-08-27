# Routines

> Routines are project-scoped, reusable agent instructions that may be run
> manually or on a YA-server-instance-specific schedule, either as a turn in
> an existing session or as a new session, with local and committed shared
> forms plus browsable run history.

Topic: routines

Status: **proposal only; nothing implemented (2026-07-28).**

## Product Decision

The product object is a **routine**, not a scheduled task and not a library
entry. A routine remains useful without a schedule: it can be browsed, edited,
and run manually. Scheduling is optional activation state layered on the same
object.

Every routine is project-specific and has one of two source scopes:

- **Local routine** — clone-local content under
  `<project>/.yep/routines/`; this is the default.
- **Shared routine** — ordinary project content under
  `<project>/routines/`, intended to be reviewed and committed with the
  repository.

“Local” and “Shared” describe the useful contrast without implying that a
shared routine is internet-public or that a local routine is a secret store.
The create flow defaults to Local and offers a nearby **Share with project**
choice that creates the shared file and stages only that new path in Git.

The activation state and scheduling even for shared routines is specific to
one YA server instance. A committed routine never activates itself, and
cloning or pulling a repository must never start agent work. Two YA servers
viewing the same repository may independently schedule the same shared routine
with different targets, times, models, or permission modes.

### Repository content cannot activate a routine

Adding, editing, staging, committing, cloning, or pulling a shared routine
cannot create YA activation or execution state. Routine discovery reads source
content only. The file format has no executable hook, autorun flag, schedule,
or other field that YA interprets as permission to run.

Only an authenticated YA user action on that server instance can:

- run a routine manually; or
- create or enable the activation whose future cron ticks materialize runs.

An agent with ordinary project and host access can of course read a routine
file and choose to follow or invoke it during its own active session. That is
ordinary agent behavior under the session's permissions, not activation caused
by repository content and not a repo-to-YA autorun path.

## Routine Source

A routine source contains:

- a required name;
- reusable instruction text;
- an optional description, expected to be uncommon but useful when
  collaborators need intent beyond the name.

Local and shared routines should use the same small, human-editable Markdown
format so a routine can move between scopes without conversion. A possible
shape is:

```markdown
---
name: Daily code review
description: Flag risky changes and missing tests from the last day.
---

Review commits from the last 24 hours. Summarize what changed, call out risky
patterns or missing tests, and note anything worth following up on.
```

The exact file schema remains open. In particular, avoid requiring a generated
UUID unless external renames prove that path-based identity is too fragile.
The source file must not contain activation state such as cron expressions,
enabled flags, target session ids, machine paths, provider credentials, or
last-run status.

### Source ownership and Git behavior

- YA discovers routine files from both conventional directories and reflects
  edits made outside YA.
- When YA creates `.yep/routines/`, that same creation operation adds it to the
  clone's repository-local Git exclude, following the safety model in
  [attachment-storage](attachment-storage.md). Creating a routine in an
  existing directory never adds or restores the exclusion: the project owner
  may have removed it deliberately. Do not use `.gitignore` or ignore all of
  `.yep/`; other YA conventions may deliberately keep committed configuration
  there.
- If `.yep/routines/` is already tracked, YA must refuse to describe a newly
  written file there as Local. It should offer the shared location or a
  genuinely untracked fallback rather than mislabeling the content.
- Creating or promoting a shared routine writes `routines/<slug>.md` and stages
  only that path. It does not stage the rest of the worktree.
- A shared routine remains ordinary repository content. YA must show its path
  and Git-visible status; “shared” is not a hidden YA synchronization system.
- A schedule resolves the current routine source when it materializes a run
  and snapshots the exact instructions used. Missing or invalid source blocks
  the run visibly; it never falls back to a stale hidden copy.

### Shared prompt changes require renewed approval

Enabling a shared routine approves the exact executable instruction content,
not every future version of its repository path. YA stores the approved content
SHA and the approved instruction snapshot in private clone-local state, such as
force-excluded `.yep/routine-source-approvals.json`; neither value is committed
with the shared routine.

Routine discovery watches or polls shared sources through one bounded
project/server facility. As soon as it observes that a shared routine's current
content SHA differs from its approved SHA, without waiting for the next run:

- the Routines navigation entry shows an alert badge whose count is the number
  of changed shared routines awaiting approval;
- opening Routines leads with an approval review showing the exact approved →
  current instruction diff, the routine identity, and its source path; and
- every due occurrence for that routine remains visibly blocked before
  dispatch until an authenticated user approves the changed prompt.

Content drift does **not** disable, pause, or delete the activation, change its
cadence, or discard already recorded history. Approval advances the stored SHA
and snapshot to the reviewed content, clears that routine from the badge, and
lets blocked/future occurrences use the normal overlap and dispatch rules.
Rejecting or deferring leaves the activation intact but execution-blocked.
Manual **Run now** on a drifted shared routine uses the same diff-and-approval
gate; the explicit run action is not permission to skip reviewing changed
instructions.

## Browse And CRUD

The primary project surface is named **Routines**, not **Scheduled**. A
schedule is only one property of a routine, and a Scheduled-only view would
hide the manually run half of the feature.

The first browse surface should be nested under a project because routine
ownership is project-specific. A later top-level Routines page may aggregate
across projects with a project filter, but it should present the same routine
objects rather than introduce a second global store.

Each routine row should make these facts glanceable:

- name and optional description;
- Local or Shared source scope;
- Manual, Paused, or the active cadence;
- next due time and timezone when active;
- last-run state and a link to run history.

Available actions:

- Run now;
- Edit;
- Schedule;
- Reschedule;
- Pause or resume;
- Unschedule without deleting the routine or its history;
- View runs;
- Move between Local and Shared, preserving activation and history;
- Delete, with source-file and activation effects stated separately.

The create/edit view should support the whole operation in one place: name,
optional description, instructions, source scope, run target, and optional
schedule. This keeps the convenient first-party flow shown by Codex Scheduled
tasks and Claude Routines without making a schedule mandatory.

### Save from a session

A session action may open **Save as routine**, prefilled from the selected or
most relevant user-authored instruction. It defaults to a local routine,
Manual, and the current session as its proposed run target. The same view may
add a schedule before saving.

Saving as a routine must not serialize the entire transcript and call it
reusable instructions. If the surrounding conversation is important, target
that existing session or choose an explicit continuity policy. Transcript
handoff is a separate context operation governed by
[session-context-actions](session-context-actions.md).

## Activation And Schedule

Activation is server-owned persisted state in the YA data directory, keyed to
the server instance and a routine source reference. It includes:

- active or paused state;
- explicit cadence and timezone;
- existing-session or new-session target;
- provider/model/permission-mode choices needed for a new session;
- overlap and missed-run policy;
- optional notification preference;
- context-continuity policy when the target creates sessions.

The schedule editor uses ordinary controls, not natural-language schedule
parsing:

- Manual;
- Hourly;
- Daily;
- Weekdays;
- Weekly;
- Custom cron;
- explicit time and timezone controls where applicable.

Presets compile to the same canonical cron representation as Custom. The UI
shows a human-readable cadence and next fire time next to the controls, but
the persisted schedule is explicit structured data. Custom cron syntax,
daylight-saving-time behavior, and minimum granularity must be settled before
implementation; five-field minute-granularity cron is the likely first
contract.

Changing or removing a schedule never edits the shared routine file. Editing a
shared routine does not rewrite or disable any YA server's activation; it moves
that server into the changed-prompt approval state above until a user reviews
and approves the new content. Missing or invalid source remains a separate
visible blocker.

## Run Targets

### Existing session

The activation stores the canonical YA session id, never only a
provider-native resume handle. Each occurrence submits the routine instructions
as an ordinary user turn in that session.

If the session is busy, the scheduled occurrence waits durably for the
end-of-turn delivery boundary. It must not steer or interrupt the active turn.
If the session is missing, archived, killed with automatic resume disabled, or
otherwise cannot accept work, the occurrence becomes visibly blocked or
failed; it does not silently create or retarget to another session.

### New session

Each occurrence may create a new session in the routine's project using the
activation's server-local provider, model, permission mode, and related launch
settings. The created YA session is the durable output and the run-history
link.

For the canonical project checkout, a due occurrence should enter the normal
project-idle dispatch boundary rather than racing other agent work in the same
tree. In the first implementation, “9:00 AM” may therefore mean “becomes due
at 9:00 AM and starts when the project is safe,” which must be visible in the
UI. A future workstream target may provide an isolated checkout with its own
idle gate; see [workstreams](workstreams.md).

Scheduling and Project Queue should share safe session/new-session dispatch
mechanisms, but they are not the same product object. Project Queue orders
user-prepared backlog after project quiet; a routine schedule materializes
occurrences by wall-clock time, owns overlap/missed-run policy, and retains
recurrence history.

## Context Continuity

The two simple policies are:

- **Existing session** — every run continues the explicitly selected session,
  accepting that its context grows.
- **Fresh new session** — every run starts without prior run context.

A useful intermediate policy is **reset every N runs, retaining only the
previous run**:

- `N = 0` means every run is fresh.
- `N > 0` reuses a routine-owned session for N occurrences.
- On rollover, the next session receives only the immediately previous
  occurrence as explicit context, not the routine's whole run history.

This bounds context growth while preserving enough continuity for monitoring
and review routines. It should remain a follow-up until the exact
provider-neutral handoff is chosen. A raw copied exchange, bounded generated
recap, native fork, and template handoff have different cost and fidelity
semantics; YA must name the mechanism rather than hiding it behind “keep one.”
See [provider-context-economics](provider-context-economics.md) and
[session-context-actions](session-context-actions.md).

## Materialization And Dispatch

A cron tick first creates a durable **run occurrence**. Execution may happen
later when its target becomes eligible. This separation prevents a restart,
busy session, or busy project from turning a due routine into an invisible
lost message.

Recommended first policies:

- at most one scheduled pending or running occurrence per activation;
- if another cadence fires while one is pending or running, record it as
  skipped for overlap rather than stacking duplicate work;
- do not backfill every missed cadence after YA or the host was offline;
- default to recording missed occurrences as missed and schedule the next
  future cadence;
- a later explicit option may run one missed occurrence when the server
  returns;
- no hidden random delay or jitter in a user-chosen wall-clock schedule;
- manual **Run now** creates its own occurrence and makes any eligibility
  delay visible; if another occurrence is pending or running, it asks whether
  to run anyway rather than silently bypassing the overlap policy.

Unscheduling prevents future materialization but does not cancel a run already
pending or active. Cancelling that run is a separate explicit action.

The YA server instance owns Routine activation semantics and run history. If
the proposed [yacron](yacron.md) service becomes the concrete schedule owner,
YA adapts Routine activations to that generally running service rather than
maintaining a second timer engine. Routine scheduling must not rely on an open
browser tab or use provider-native cron/loop features:

- provider-native cron is not portable across providers;
- it can keep a provider process retained between runs;
- it obscures activation state from YA's own CRUD and run history;
- it couples cadence to natural-language/provider controls the product has
  deliberately rejected.

The server should use one bounded global scheduler or next-wakeup service, not
one immortal timer or provider process per routine. With no active schedules,
it owns no recurring routine work. Between occurrences, no routine keeps a
provider session alive merely to preserve context. These requirements extend
[architecture-mandates](architecture-mandates.md).

## Run History

Manual and scheduled executions produce the same run record. A record includes:

- routine source scope/path and content revision or hash;
- an immutable snapshot of the instructions actually submitted;
- scheduled due time, actual materialization time, and start/end times;
- Manual or scheduled origin;
- target kind and resolved YA session id;
- state such as pending, running, succeeded, failed, skipped-overlap,
  missed-offline, blocked, or cancelled;
- a concise failure/blocker reason.

History is browsable from the routine and links to the resulting session or
turn. The provider transcript remains the detailed execution record; routine
history is an index and audit trail, not a duplicate transcript store.
Persistence and APIs must paginate or otherwise bound in-memory reads rather
than loading an unbounded lifetime history.

Editing, rescheduling, pausing, unscheduling, or moving a routine between
Local and Shared does not erase earlier runs. Each record keeps the source
revision and server-local activation facts that produced it.

## Safety And Defaults

- Creation defaults to Local and Manual. Nothing runs until the user
  explicitly chooses Run now or activates a schedule.
- Sharing and activating are separate decisions. “Share with project” never
  implies “run on this server,” and an active local routine may later become
  shared without changing its schedule.
- Permission mode is visible at activation and run time. A scheduled new
  session must not silently escalate from the user's chosen mode.
- Routine instructions are sent to an agent and retained in session/run
  records; neither Local scope nor a private repository makes them a secret
  store.
- A shared-routine create or scope promotion is an explicit Git write and
  stage operation. YA shows the exact path and never stages unrelated work.
- Hosted clients must capability-gate Routines against older servers before
  showing working controls; the compatibility plan belongs at implementation
  time under [server-capabilities](server-capabilities.md).
- The feature is inert until deliberately used, but its discoverable sidebar
  surface is still new UI. It may remain behind an experimental/presence
  setting while immature, consistent with [vanilla-defaults](vanilla-defaults.md).

## Recommended First Slice

1. Discover and CRUD local/shared routine files with Local + Manual
   defaults.
2. Add the project-nested Routines list and all-in-one create/edit view.
3. Run manually into the current/existing session or a new session.
4. Add one server-instance activation per routine with schedule presets,
   Custom cron, pause/resume, reschedule, and unschedule.
5. Materialize durable occurrences, dispatch them through existing safe
   session/new-session boundaries, and show run history.
6. Defer reset-every-N continuity, workstream targets, cross-project
   aggregation, and missed-run catch-up options until the basic execution
   contract is proven.

## Open Decisions

- Exact Markdown/frontmatter schema and rename identity.
- Whether the project-nested page is sufficient or a top-level aggregate
  should ship in the first slice.
- Exact cron syntax, timezone source, daylight-saving-time behavior, and
  minimum interval.
- Whether Paused and Unschedule both earn separate UI actions in the first
  slice.
- Default handling for one missed occurrence after a short server outage.
- Exact previous-run handoff for reset-every-N continuity.
- Whether a new-session routine may opt into immediate isolated execution
  before workstream targeting exists.
- Whether editing a shared routine in YA stages that edit automatically or
  reserves automatic staging for create/promote only.

## Related Topics

- [yacron](yacron.md) — proposed headless local owner for durable deadlines,
  occurrences, and provider-host dispatch.
- [architecture-mandates](architecture-mandates.md) — bounded ownership of
  global background work.
- [project-queue](project-queue.md) — durable project-idle dispatch for
  existing and new sessions.
- [session-liveness](session-liveness.md) — safe idle and end-of-turn evidence.
- [steer-queue-provider-differences](steer-queue-provider-differences.md) —
  provider delivery boundaries for a busy existing session.
- [provider-context-economics](provider-context-economics.md) — cost of
  persistent versus fresh session context.
- [session-context-actions](session-context-actions.md) — honest fork/handoff
  mechanisms for continuity rollover.
- [workstreams](workstreams.md) — possible isolated checkout targets.
- [vanilla-defaults](vanilla-defaults.md) — presence and default behavior.
