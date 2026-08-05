# Make Glossary Discovery Follow Only the Requested Source Context

> Resolve the governing `GLOSSARY.md` from the queried directory and its
> parents, then follow only explicit glossary includes; never crawl the project
> or attach a recursive project watcher merely to answer that question.

Status: Implementation handoff, not yet implemented. The glossary grammar,
artifact compiler, and client in-place activation are already implemented by
tactical 087. This follow-up removes the avoidable filesystem work found by
tactical 089 without changing glossary precedence or include semantics.

Related contracts:

- [`topics/glossary-tooltips.md`](../../topics/glossary-tooltips.md)
- [`topics/project-path-links.md`](../../topics/project-path-links.md)
- [`091-project-path-cache.md`](091-project-path-cache.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Current fault and measured cost

`GlossaryIndexService.resolveCanonical()` already constructs the correct small
candidate set: `GLOSSARY.md` in the source directory, then each parent through
the project root. Explicit includes generate only the paths authored in the
governing files. The fault is downstream ownership:

- acquiring `getProjectPathIndex()` starts the unrelated 50,000-node project
  warm; and
- `ProjectGlossarySubscriptionManager.attachWatcher()` calls recursive
  `fs.watch(projectRoot)`, causing Node/Linux to walk the selected project
  synchronously while installing watches.

In the 089 production measurement, the artifact itself completed in about
75 ms, while subscription setup blocked the event loop for about 2.5 seconds.
The project happened to contain roughly 50,000 paths, mostly irrelevant run
artifacts. A typical project's combined glossary closure is below 1,000
entries, so parsing and automaton construction were not the owner.

## Governing lookup contract

For prose rendered from `a/b/file.md`, probe only:

1. `a/b/GLOSSARY.md`;
2. `a/GLOSSARY.md`; and
3. `GLOSSARY.md`.

Stop at the first existing governing file. When the rendered source is itself
`GLOSSARY.md`, preserve the existing no-tooltip boundary. For an explicit
include, probe only the existing two bases—relative to the referring glossary
and relative to project root—after containment normalization. Do not discover
other glossaries by basename or scan sibling directories.

The sparse project-path cache from tactical 091 is the shared accelerator when
available. Glossary correctness must not require that cache to be complete or
pre-warmed: unknown candidates are exact-probed. A complete/current directory
node may answer absence immediately; a partial node may not.

## Watch and reconciliation contract

Replace the single recursive root watcher with non-recursive watchers for the
parent directories of observed governing/include candidates. Missing
`GLOSSARY.md` candidates remain observed so later creation is detectable.
When resolution adds a new observed directory, the subscription manager must
attach or reuse that directory watch promptly; a five-minute poll is not the
notification path for registering newly observed candidates.

The manager therefore needs an explicit observation-change handoff from
`GlossaryIndexService`, or an equivalent route-level call after resolution.
Polling remains a bounded backstop over observed candidates only. Watch error,
overflow, or a filename-less event marks the project generation uncertain,
invalidates affected compiled closures, and schedules reconciliation. Unused
project subscriptions close their directory watches and remain subject to the
existing retained-project bound.

The client continues to request the artifact asynchronously. Session display
and the stable top of a hovercard do not wait for glossary readiness; the
artifact activates in place after it is ready.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Governing and include candidates | `packages/server/src/projects/glossaryIndexService.ts` | Preserve the existing candidate algorithms; remove any dependence on full index warm and publish newly observed parent directories |
| Filesystem subscriptions | `packages/server/src/projects/projectGlossarySubscriptionManager.ts` | Replace one recursive root watcher with deduplicated non-recursive observed-directory watches |
| Sparse path truth | `packages/server/src/projects/projectPathIndex.ts` | Exact-probe unknown candidates and share negative/completeness state from tactical 091 |
| Artifact route/subscription | `packages/server/src/routes/glossary-artifacts.ts`, `ws-relay-handlers.ts` | Keep the current capability and response/event vocabulary; ensure observation registration races cannot miss a watch |
| Server tests | `packages/server/test/projects/glossaryIndexService.test.ts`, `projectGlossarySubscriptionManager.test.ts` | Add I/O breadth, watcher lifecycle, creation/deletion, and uncertain-generation coverage |
| Route/event tests | `packages/server/test/routes/glossary-artifacts.test.ts`, `ws-relay-glossary.test.ts` | Preserve capability-gated artifact and ordered snapshot/change behavior |
| Client readiness | `packages/client/src/lib/glossary/GlossaryArtifactStore.ts` and tests | Preserve non-blocking, generation-ordered in-place activation; no new eager load |

## Recommended implementation order

### 1 — prove candidate breadth before changing cache internals

Add fixtures with a deep queried source, parent glossaries, explicit includes,
and a large unrelated subtree. Assert the exact probed path list and zero
directory reads below the unrelated subtree. Cover no glossary, nearest wins,
root fallback, contained include, escaped include, and a source that is itself
a glossary.

### 2 — make exact probes independent of project warming

Route governing/include existence through the sparse exact-probe behavior from
tactical 091. If this tactical lands first, add the narrow exact-probe seam
without duplicating a second glossary-only filesystem cache; tactical 091 then
takes ownership of its shared state.

### 3 — replace the recursive watcher with observed-directory watches

Change project state from one `watcher` to a directory-keyed watcher map.
Attach only after a candidate parent is observed, deduplicate shared parents,
and close unused watchers on project deactivation/eviction. Preserve debounce
and ordered generation semantics.

### 4 — reconcile watcher uncertainty without a project crawl

On ambiguous events or errors, stat/re-probe only observed glossary candidates.
Invalidate the project artifact generation before emitting corrected paths.
Keep the existing bounded poll as a missed-event backstop over the same set.

### 5 — measure cold and warm activation

Record time to session data, glossary artifact, watch readiness, and in-place
activation on a project with at least 50,000 unrelated paths. Compare hints off
and on. The session response/top content must remain stable while hints become
ready.

## Acceptance

- A query probes only the source directory, its parents, and explicit include
  candidates; it never scans siblings or the full project.
- Enabling glossary hints on the 50,000-path fixture performs no recursive
  `fs.watch` and no event-loop-blocking project walk.
- Creating or deleting a previously observed `GLOSSARY.md` produces one
  ordered generation update and invalidates the compiled closure.
- Newly observed nested directories become watched without waiting for the
  fallback poll.
- Watch failure/ambiguity cannot leave stale positive or negative glossary
  truth trusted indefinitely.
- Session rendering does not wait for glossary discovery, and in-place
  activation does not move or flash already displayed opening content.
