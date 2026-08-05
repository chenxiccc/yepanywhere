# Project path links in viewed content

> A bare project-relative path appearing in file content is a link, because it
> names a file that exists here — not because it looks like a path.

Topic: project-path-links

Status: **implemented (2026-08-02); demand-driven cache landed 2026-08-05.**
Highlighted file content links exact project files through a demand-driven,
watcher-backed directory cache. Tracked, untracked, and gitignored files share
the same membership test. The breadth-first warm, the per-use directory-mtime
validation, and the `.yepignore` crawl exclusions this feature originally
shipped with are gone.

## Why membership, not shape

An agent hands over a JSON manifest of run outputs and the reader wants to open
one. Detecting "path-like" strings by shape — a `/`, a known extension, a key
named `*path*` or `*file*` — needs a rule per false positive: `application/json`
is not a file, `1.2.3` is not a file, and a `"path"` key can hold something that
was deleted an hour ago.

The test is instead membership in the project's own path set. A string links
because it *is* a file in this project. That has no false positives to tune,
needs no key-name convention, and cannot link something that is not there. It
also means the mechanism is safe to run over arbitrary content rather than only
over JSON.

**Project-relative only.** An absolute path outside the project is not linked
here; the Markdown viewer's own local-file handling covers authored links.

## The index

`packages/server/src/projects/projectPathIndex.ts` holds one demand-driven
cache per project. The filesystem is authoritative; Git is never consulted, so
ignored files need no special case. The cache is rebuildable app state: it
lives in memory, and no lookup, cache, watch, or diagnostic ever writes inside
the selected project or its Git metadata.

**Nothing is read until something is asked.** Creating an index performs no I/O
at all, not even a project-root listing, and starts no warm, timer, or retry
loop. Only the directory components a candidate actually names are hydrated. A
project holding 50,000 unrelated run artifacts costs nothing because one
displayed turn mentions `src/server.ts`, and that lookup performs no I/O under
`runs/`, `.git/`, or `node_modules/`. Those directories need no exclusion list
because nothing enumerates them.

**Each component edge records only what was proven** — `unknown`, `directory`,
`file`, or `absent` — and each directory node separately records whether its
listing is *complete*. The two facts have different strength. Only a complete
directory answers arbitrary child absence without I/O. An exact failed probe
caches that one edge as absent and claims nothing about its siblings; a present
edge likewise implies nothing about unobserved siblings.

**A live watcher is what makes a cached fact trustworthy.** Each hydrated
directory carries a non-recursive `fs.watch`, and facts under a directory with
no watcher are never read from cache. So a cache hit costs zero `stat`, and
losing — or never obtaining — a watch makes an answer re-probe rather than go
wrong: a directory that cannot be watched still answers correctly, just from
the filesystem every time. A named event clears that one edge back to
`unknown`, including inserting an edge a complete listing had called absent. An
event that names no entry, a watch error, or overflow instead makes the whole
generation uncertain: the directory's cached facts are discarded rather than
trusted, and one bounded re-listing re-establishes them. Watch ambiguity
therefore cannot leave a negative answer trusted indefinitely.

**Probe or list, whichever is cheaper for the batch.** One lookup batch groups
candidates by parent directory. A sparse set is probed exactly with `lstat` —
`lstat`, not `stat`, so a symlink is a leaf and a link cannot walk the
traversal out of the project. Four or more unknown names in one not-yet-complete
directory are worth a single `readdir` instead, which then answers every later
name in that directory. A listing wider than 20,000 entries is not retained
whole — one directory would otherwise claim a large share of the project's
entire budget — but the names that batch asked about are kept as ordinary
proven edges, since the watch was already attached when the read covered them.
The width itself is remembered, so later batches in that directory probe
exactly instead of re-reading it every time; the cap therefore bounds what may
be *claimed complete*, not what may be known. Discarding the directory's
generation forgets the width too, so a directory that has since shrunk is
listed again rather than probed forever.

**Retention is byte-bounded at two levels.** Within a project, least-recently-used
hydrated directories are dropped once retained bytes exceed 4 MiB. Across the
process, `getProjectPathIndex()` hands each caller a refcounted claim, and
unclaimed projects are dropped least-recently-used past 32 MiB; a claimed
project is never evicted out from under its holder. Ten thousand dormant
projects therefore do not mean ten thousand live tries or watchers, and a
discarded project still answers — it rebuilds only the components it needs.
Eviction runs only between batches, so a probe in flight keeps its ancestors.

`projectPathCacheDiagnostics()` reports project count, retained bytes, and
evicted projects; per-index counters cover cached answers, exact probes,
directory listings, oversized listings, watcher invalidations, uncertain
generations, and evicted directories. Reading either scans no tree.

**Completion is an explicit request, not a side effect.** The replacement plan
sketched an optional `listDirectory()` on the interface; it is deliberately
unbuilt, because no product surface asks for a complete inventory. A surface
that later needs one must request and budget that operation, never restore it
to index construction. The same rule retired the `.yepignore` crawl-exclusion
file with the warm it configured.

## Rendering

Linkification runs server-side over already-highlighted HTML, in the same
response that produces it, so the client needs no path corpus and no second
request. A first pass collects distinct candidates, the index resolves them in
bounded concurrent directory batches, and a second pass rewrites only the
confirmed files. Matches use the same `renderLocalFileLink` markup the Markdown
viewer emits, so the existing `data-ya-resource="local-file"` interception
opens them in the same popup.

Constraints that keep it safe over arbitrary markup:

- Only text between tags is rewritten. Markup is never matched, so a real
  project path appearing inside a tag attribute cannot corrupt the HTML.
- A match must fall inside one text run. Highlighted output nests spans per
  token, and a path split across two spans stays unlinked rather than risking a
  rewrite across a tag boundary.
- Token boundaries exclude quotes, brackets, commas and colons, so a JSON
  string value yields the path without swallowing its punctuation.
- `&` is excluded, because the surrounding HTML is escaped and a decoded entity
  would not round-trip. Paths containing `&` are not linked.
- The file being viewed does not link to itself.

An empty or unavailable index returns the content unchanged, so the feature
degrades to plain content rather than failing the view.

## Not yet covered

Only the file viewer's highlighted source runs this. Other viewers showing
project content — diff panes, tool-result bodies, turn text — would use the same
`linkifyProjectPaths` seam.

**Server annotation, not a client corpus.** Extending to streaming turn text
raises the option of shipping the path set to the client and matching there, the
way glossary tooltips ship a compiled automaton
([glossary-tooltips](glossary-tooltips.md) § Compiled matcher contract). That
was considered and rejected in 2026-08-05 design discussion. The path set is
three to five orders of magnitude larger than a glossary's — 131,956 files here
and 594,511 in a research repository — so the artifact is a different weight
class on a mobile-first client, and it is open rather than closed: any write
anywhere changes it, whereas glossary terms change only on an edit the
subscription already streams. Against that, a path link is decided once per body
the server is already rendering, so nothing needs re-deriving client-side.

Server annotation also keeps the demand-driven cache sufficient. A shipped
corpus would require enumeration — the `git ls-files` set this feature's own
history rules out on correctness, since it omits the ignored run outputs that
motivated the feature — while the server only ever answers about text it is
currently rendering. So the mandate against a project-wide crawl stands
unamended, and the open questions for a turn-text surface are annotation
granularity (per completed block rather than per streamed delta, which would put
a filesystem-backed pass on a token-rate path) and holding a path-cache claim
for the viewed project rather than per request.

## Replacement evidence

The original flat index used `git ls-files` plus porcelain-v2 untracked paths.
It missed ignored run outputs, while enumerating ignored files up front measured
2.5s for 131,956 files here and 3.5s for 594,511 in a research repository. Its
global freshness sweep also measured 135ms for 10,845 directories against 220ms
to rebuild. Those results ruled out repairing the flat set with another Git
enumeration or a wider sweep.

The replacement test suite covers ignored membership, sparse component-chain
I/O, listing-vs-probe batch choice, absolute and parent-traversal rejection
before I/O, concurrent-probe coalescing, watcher invalidation, a forced
watcher-uncertain generation and its reconciliation, unwatchable directories,
oversized listings, per-project and process-wide eviction, HTML safety,
self-link suppression, and batch I/O cost.

The warm the demand-driven cache replaced was itself the second design. It
started a breadth-first crawl of up to 50,000 path-component nodes and 12
directory levels for every touched project, validated each traversed directory
by mtime `stat` on every use, and left the process-wide project map with no
eviction. Auditing the real consumers — `linkifyProjectPaths`, `GlossaryIndexService`
governing/include resolution, and Markdown rendering in `routes/files.ts` —
found that none asks for an inventory: each asks `findExisting()`/`has()` about
a handful of paths already displayed on screen. The crawl was therefore paying
for an answer nothing requested, which is why the cache now hydrates only the
components a candidate names and why a future completion surface must budget
its own listing rather than reinstate a crawl.

A 2026-08-02 end-to-end measurement of the warm-based index used the motivating
ignored file under `trtllm-speculative/draft`: 10,000 highlighted tokens, 191
distinct candidates in one parent directory, and 500 occurrences of the
existing file.

| state | elapsed | `stat` | `readdir` | links |
|---|---:|---:|---:|---:|
| cold trie | 22.3ms | 8 | 4 | 500 |
| cached parent, median of 5 | 9.4ms | 1 | 0 | 500 |

The five cached-parent timings ranged from 7.0–11.2ms. This is a local
regression measurement, not a cross-machine latency guarantee; the structural
result is the stable part, and the demand-driven cache holds it while removing
the crawl behind it. The same 191-candidate shape is asserted in the test
suite: cold, one exact probe for the parent component plus one listing that
answers all 191 names; warm, no filesystem call at all, where the warm model
still paid one validation `stat`.
