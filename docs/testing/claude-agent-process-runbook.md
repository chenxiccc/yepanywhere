# Driving a Claude Agent Process Through the Local API

Use this runbook when one supervising agent needs to give a bounded repository
slice to a fresh Claude worker, wait for that worker to finish, and independently
audit the result. It describes the local YA API on the default
`https://localhost:3400` server. It is not a remote automation or unattended
deployment contract.

The controller owns selection, scope, acceptance, and batch progress. The
worker owns only the approved slice. A worker report is evidence, not proof;
Git state and checks rerun by the controller are authoritative.

## Safety and checkout invariants

- Use one worker at a time in a shared checkout. Do not edit the tree from the
  controller while the worker is active.
- Record a clean base SHA before launch. A dirty tree makes attribution and
  rollback ambiguous, so stop rather than guessing which changes belong to the
  worker.
- Give the worker an explicit file boundary and permission to stop. It may not
  substitute another candidate when the approved slice is blocked.
- `bypassPermissions` is appropriate only for a trusted local checkout and a
  reviewed, tightly bounded prompt. Choose a supervised permission mode when
  those conditions do not hold.
- Use `-k` only for the expected self-signed localhost certificate. Do not
  generalize certificate bypass to a remote server.
- Capture the returned YA `sessionId` as the canonical session identifier. Do
  not replace it with a provider-native id.

For CSS migrations, choose and drill into the owner with
`pnpm css:inventory` before starting this runbook. The binding migration rules
remain in [`topics/css-architecture.md`](../../topics/css-architecture.md).

## 1. Freeze the work order

Before launch, the controller records:

- base commit and clean `git status`;
- one selected product surface;
- inventory evidence and every known ownership edge;
- allowed ordinary files and conditional tool-repair files;
- focused tests and required repository checks;
- a deterministic browser route/state when rendered UI changes; and
- stop conditions, including the maximum batch size.

For visual work, find the route before launching the worker. Confirm through
the normalized session-detail API that the target tool or component is present
in the loaded transcript. Do not hand a worker a vague instruction to search
historical sessions until something happens to render.

## 2. Build a bounded worker prompt

The prompt should contain these sections in this order:

1. **Authority and base:** current repository, exact base SHA, permission to
   edit and commit, and prohibition on branches, worktrees, and delegation.
2. **Frozen candidate:** one component or surface, its current inventory
   metrics, and every already-known edge.
3. **Allowed files:** ordinary migration files plus narrowly conditional files
   for an analyzer regression.
4. **Trust gate:** when ownership, a producer, generated vocabulary, or a
   coupling edge is materially wrong, add the smallest regression, repair the
   analyzer in a separate commit, regenerate inventory, and end the batch.
5. **Mechanical rule:** move behavior before cleanup; no redesign, adjacent
   refactor, broad `className` normalization, or replacement candidate.
6. **Verification:** exact focused tests, ratchets, lint/typecheck, console
   scan, desktop/mobile visual states, and `git diff --check`.
7. **Commit rule:** one commit only after every required check succeeds.
8. **Final report:** status, commit, files, before/after metrics, edges, checks,
   captures, scope pressure, and recommendation.

Five slices is an audit interval, not a quota. A worker completes one slice and
returns; the controller decides whether another fresh session should start.

## 3. Launch the session

Get the project id from `GET /api/projects` or an existing project URL. Every
mutating request must send `X-Yep-Anywhere: true`; omitting it returns `403
Missing required header`.

```bash
curl -ksS \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Yep-Anywhere: true' \
  'https://localhost:3400/api/projects/<project-id>/sessions' \
  --data '{
    "message": "<bounded worker prompt>",
    "provider": "claude",
    "model": "opus",
    "thinking": "on:high",
    "mode": "bypassPermissions",
    "recapMode": "off",
    "promptSuggestionMode": "off"
  }'
```

`model: "opus"` is the YA model alias. Verify the live process rather than
assuming its resolved provider name; the pilot resolved it to
`claude-opus-5` with effort `high`.

A successful immediate launch returns `200` with `sessionId`, `processId`, and
`projectId`. Persist all three with the base SHA and prompt digest.

### Queued-launch limitation

A `202` response contains a queue id but does not currently provide a durable
way for an external controller to recover the new session id after that queue
entry starts. Do not automatically submit the prompt again: the first request
may still start and duplicate the work.

Prefer a sequential controller and inspect `GET /api/queue` before launch. If
a launch still returns `202`, stop automated progression and surface the queue
id for manual reconciliation. A durable queued-result handoff is the first API
improvement to make before relying on this for unattended batches.

## 4. Poll the authoritative process state

Poll every three to five seconds:

```text
GET /api/sessions/<session-id>/process
```

Use the process state, not transcript-file growth, as the turn boundary:

| Observation | Controller action |
|---|---|
| `in-turn` and progressing/retrying | Continue polling. |
| `waiting-input` | Stop and ask the supervisor; never approve automatically. |
| `providerRuntimeStatus.kind == "terminal"` | Mark failed and inspect the provider error. |
| `idle`, `queueDepth == 0`, `activeWorkKind == "none"`, and `verified-idle` | Turn completed; fetch the report and begin audit. |
| `terminated` | Mark failed and inspect `GET /api/processes?includeTerminated=true`. |
| `process: null` before an observed terminal boundary | Stop; reconcile session detail and recently terminated processes. |

Use a wall-clock deadline as well as liveness. Progress evidence permits a
long-running check; it does not permit unlimited research outside the work
order. Keep a separate, short discovery budget for visual state. One normal
Playwright attempt plus one route-specific correction is usually enough; after
that, stop and report the missing deterministic state.

## 5. Read output and steer a wandering worker

Read the provider-neutral transcript from:

```text
GET /api/projects/<project-id>/sessions/<session-id>
```

The final assistant text lives in the normalized `messages[].message.content`
blocks. Prefer this endpoint to Claude JSONL or Codex rollout files. Raw
provider files are a debugging fallback, not the orchestration interface.

To give a bounded correction while the turn is active:

```bash
curl -ksS \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Yep-Anywhere: true' \
  'https://localhost:3400/api/sessions/<session-id>/messages' \
  --data '{
    "message": "Supervisor steer: stop the out-of-scope discovery, do not commit, and return a stopped report.",
    "mode": "bypassPermissions"
  }'
```

The pilot delivered this steer after the worker's current shell command
finished. The worker left its approved files staged and returned without a
commit. Treat steering as graceful correction, not instant process
cancellation; use the explicit interrupt/abort controls only when graceful
steering is insufficient and the operator has chosen that outcome.

## 6. Audit independently

After the process reaches verified idle:

1. Confirm the base and inspect `git status`, staged and unstaged diffs, and all
   commits since the base SHA.
2. Reject files outside the work order unless the worker stopped at the
   analyzer trust gate and the conditional repair scope explains them.
3. Re-run inventory and compare ownership, coupled, generated, dynamic, and
   unresolved findings.
4. Re-run the focused tests and warning-sensitive checks. Do not infer success
   from a piped/truncated worker command whose shell exit status may belong to
   `tail` rather than the check.
5. For CSS work, independently run `css:check`, `css:unused`, lint, typecheck,
   console scan, and the relevant tests. Record an advisory `css:unused` exit
   separately from a regression.
6. Inspect desktop and phone captures yourself. Computed widths are useful
   supporting evidence but do not replace looking at the images.
7. Accept and commit only when the controller's evidence is complete.

If the worker committed before audit, acceptance is still a separate decision.
Do not start the next session merely because a commit exists.

## 7. Run a batch of at most five

For each accepted slice:

1. record its commit and new clean base;
2. regenerate the inventory;
3. select the next candidate from the new data;
4. launch a fresh Claude session with a new frozen prompt; and
5. stop after five accepted slices and return the batch report.

End the batch immediately when:

- the analyzer changes materially;
- a candidate needs an unapproved production boundary;
- the working tree is not attributable to one worker;
- required visual state is not deterministic;
- a warning/check budget regresses; or
- the controller cannot attach a queued launch to its resulting session.

The batch report includes accepted/stopped sessions, commits, ratchet movement,
before/after inventory, verification evidence, steering or input events, and a
fresh top-candidate list. It does not silently begin the next batch.

## Pilot observations

The first CSS pilot validated the launch, polling, normalized transcript,
steering, and stopped-report paths. It also exposed two useful controller
requirements:

- the mutation header must be part of every POST helper; and
- the controller should supply a small, confirmed visual route instead of
  making the worker discover one after implementation.

The stopped worker preserved a bounded staged diff. The controller then found
a ten-message session whose normalized detail contained two Grep calls,
expanded its single activity group, and captured the component directly. That
is the preferred visual-state pattern for future renderer slices.
