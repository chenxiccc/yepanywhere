# Replace Project-Wide Path Warming With a Sparse Directory Cache

> Make project-file existence queries proportional to the paths actually
> mentioned by a session, while retaining exact negative answers, filesystem
> change invalidation, and useful acceleration at 10,000-project scale.

Status: Implementation handoff, not yet implemented. Tactical 089 established
that the current 50,000-node background warm is unnecessary for path-link and
glossary consumers and that the process-wide project-index map has no
project-level eviction. This plan replaces that ownership model; it does not
authorize a project-wide crawl under a different name.

Related contracts:

- [`topics/project-path-links.md`](../../topics/project-path-links.md)
- [`topics/server-performance-observability.md`](../../topics/server-performance-observability.md)
- [`topics/project-directory-storage.md`](../../topics/project-directory-storage.md)
- [`092-demand-driven-glossary-discovery.md`](092-demand-driven-glossary-discovery.md)
- [`089-main-thread-startup-cpu-investigation.md`](089-main-thread-startup-cpu-investigation.md)

## Current fault

`getProjectPathIndex()` creates one `LazyProjectPathIndex` per touched project,
reads `.yepignore`, and immediately starts a breadth-first warm through as many
as 50,000 path-component nodes and 12 directory levels. The global `indexes`
map never releases a cold project. A lookup does not wait for that warm, but it
still stats every traversed directory to validate modification time before it
uses a populated node.

The only production consumers call `findExisting()` or `has()` for explicit
candidates extracted from displayed Markdown or glossary references:

- `augmentProjectPathLinks()` in
  `packages/server/src/augments/project-path-links.ts`;
- `GlossaryIndexService` governing-directory and include resolution; and
- Markdown file rendering in `packages/server/src/routes/files.ts`.

None requires an all-project path inventory. A project with 50,000 unrelated
run artifacts should not pay to enumerate them because one displayed turn
mentions `src/server.ts`.

## Target cache model

The cache is a directory-component tree, not necessarily a character trie.
Each edge records one of `unknown`, `present-directory`, `present-file`, or
`absent`. Each directory node separately records whether its child listing is
complete for a known filesystem generation. These facts have different proof
strength:

- only a complete/current directory may answer arbitrary child absence;
- an exact failed probe may answer that one edge or missing suffix without a
  complete listing;
- a present edge does not imply that unobserved siblings are absent; and
- an uncertain watcher generation makes affected completeness/negative facts
  unusable until reconciled.

An index may list the project root once on creation, but it launches no
recursive warm. Unknown descendants become concrete only because an explicit
candidate, directory-completion request, or governing-glossary walk touches
them. Exact probes should prefer `lstat`/equivalent direct existence checks for
sparse candidate sets, rather than listing a directory that may contain tens
of thousands of unrelated entries. A batched caller may explicitly request a
complete directory listing when that is cheaper or when it needs siblings.

Filesystem modification time may be captured as reconciliation evidence, but
it is not queried on every cache hit. On Linux, non-recursive native watches on
hydrated directories provide the hot truth-maintenance path. YA-owned file
edits can invalidate the same edge directly. A missing filename, watch error,
or overflow marks the relevant generation uncertain and schedules bounded
reconciliation; it never silently blesses stale negative answers.

This is rebuildable app state. It remains in memory or bounded YA app-data
storage and never writes an index into the selected project.

## Proposed API boundary

Keep ordinary callers independent of cache layout:

```ts
interface ProjectPathIndex {
  findExisting(paths: readonly string[]): Promise<ReadonlySet<string>>;
  has(path: string): Promise<boolean>;
  listDirectory?(directory: string): Promise<ReadonlyArray<PathEntry>>;
  release(): void;
}
```

`findExisting()` remains the sparse exact-probe operation. `listDirectory()`
is an explicit completeness request, not an implementation side effect of one
failed lookup. The process-wide owner tracks estimated node/string bytes,
last access, active watchers, and current in-flight probes. It evicts cold
projects and cold subtrees by byte budget and least-recent access; a count-only
50,000-node-per-project ceiling is insufficient.

## Source map

| Concern | Current owner | Change |
|---|---|---|
| Node states, warming, mtime validation | `packages/server/src/projects/projectPathIndex.ts` | Replace `populated`/recursive warm with explicit edge state and directory completeness; add exact-probe and release accounting |
| Path-link batches | `packages/server/src/augments/project-path-links.ts` | Preserve one candidate batch; consume sparse results without requesting a warm |
| Rendered-file call site | `packages/server/src/routes/files.ts` | Preserve scoped index reuse and release inactive project ownership |
| Glossary existence | `packages/server/src/projects/glossaryIndexService.ts` | Use only governing/include candidates; detailed in tactical 092 |
| Contract and diagnostics | `topics/project-path-links.md` | Keep state semantics, watcher uncertainty, and byte/project bounds observable |
| Existing coverage | `packages/server/test/augments/project-path-links.test.ts`, `packages/server/test/projects/glossaryIndexService.test.ts` | Replace warm assertions with sparse-I/O and invalidation assertions |

## Recommended implementation order

### 1 — freeze sparse lookup behavior with I/O-counting tests

Use an instrumented filesystem adapter. Prove that querying two paths in one
deep directory touches only those candidates and their required ancestors,
does not enumerate an unrelated large subtree, and coalesces concurrent exact
probes. Preserve traversal rejection, path normalization, symlink behavior,
and project containment at the existing security boundary.

### 2 — replace the implicit warm with explicit path states

Delete creation-time breadth-first warming from `getProjectPathIndex()`.
Implement unknown/present/absent edges and the separate directory-completeness
bit. Cache an exact negative only at the strength actually established; do not
turn one failed probe into a claim about siblings.

### 3 — attach non-recursive watches to hydrated directories

Watch only directories whose cached facts are useful to an active consumer.
Invalidate the named edge/subtree on ordinary events. Mark the generation
uncertain and reconcile on watch ambiguity/error. Make teardown close every
watch before a project or subtree becomes collectible.

### 4 — add byte-aware cold-project eviction

Replace the unbounded module-level `indexes` map with an owner that tracks
last access, estimated retained bytes, watcher count, and in-flight work.
Protect current probes, then evict inactive projects/subtrees until below a
low watermark. A later lookup reconstructs state from the filesystem.

### 5 — remove obsolete crawl-only machinery

After caller coverage proves no product surface requests a full inventory,
remove the dead background-warm and `.yepignore` crawl path. If an actual
completion surface later needs a complete scan, it must request and budget
that operation explicitly rather than restoring it to index construction.

### 6 — expose cache effectiveness and pressure

Report exact probes, directory listings, complete/partial nodes, negative
hits, watcher invalidations/uncertain generations, retained estimated bytes,
and project/subtree evictions. Reading diagnostics must not scan the tree.

## Acceptance

- Creating an index performs at most one project-root listing and no recursive
  traversal.
- A candidate under `src/` performs zero I/O under unrelated `runs/`, `.git/`,
  or `node_modules/` trees.
- A complete/current directory answers child absence without I/O; an exact
  cached negative answers only its proven path.
- Creating, deleting, or replacing a watched path invalidates the affected
  result. Watch ambiguity cannot leave a negative result trusted indefinitely.
- Ten thousand dormant project identities can exist without ten thousand live
  50,000-node tries or watchers; cold state is evictable and reconstructible.
- No lookup, cache, watch, or persisted diagnostic writes inside the selected
  project or its Git metadata.
