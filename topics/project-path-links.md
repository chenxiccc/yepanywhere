# Project path links in viewed content

> A bare project-relative path appearing in file content is a link, because it
> names a file that exists here — not because it looks like a path.

Topic: project-path-links

Status: **implemented (2026-08-02).** Highlighted file content links exact
project files through a bounded, filesystem-backed path trie. Tracked,
untracked, and gitignored files share the same membership test.

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

`packages/server/src/projects/projectPathIndex.ts` holds one lazy trie per
project. Each cached directory node records its complete child listing and the
directory mtime observed with that listing. The filesystem is authoritative;
Git is never consulted, so ignored files need no special case.

**Validation is local to the referenced directory.** One lookup batch groups
candidates by parent directory. A cached parent takes one `stat`; an unchanged
mtime makes its child listing authoritative for both presence and absence. A
changed or cold parent is read between two `stat` calls and cached only when
the mtime is stable. A directory changing continuously is answered from the
bounded read but not cached, so the next lookup retries instead of blessing an
unstable snapshot.

Recent directory mtimes receive one conservative settling refresh. This keeps
creation-after-warm correct on filesystems whose mtimes are coarser than the
nanosecond timestamps available on the development host; correctness does not
depend on sub-second precision.

**Memory and background work are bounded.** At most 50,000 path-component
nodes remain cached. A listing that cannot fit is used for the current lookup
without sticking in the trie. When an index first starts, one breadth-first
warm walks at most 12 directory levels and stops at the same node bound. It has
no timer, watcher, retry loop, or session lifetime of its own; a cold lookup is
always sufficient.

The warm skips directories named `.git` and `node_modules` by default. An
optional project-root `.yepignore` replaces the default `node_modules`
exclusion; `.git` is always skipped. Its intentionally small format is one
project-relative directory per line, with blank lines and lines beginning `#`
ignored. It is not gitignore syntax: globs, negation, and inline comments have
no special meaning. An unreadable or malformed file logs once and falls back to
the defaults.

Warm exclusions never restrict lookup. A path under `node_modules`, `.git`, or
a `.yepignore` entry still links when the file exists; the first reference just
reads that directory on demand.

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
project content — diff panes, tool-result bodies — would use the same
`linkifyProjectPaths` seam.

## Replacement evidence

The original flat index used `git ls-files` plus porcelain-v2 untracked paths.
It missed ignored run outputs, while enumerating ignored files up front measured
2.5s for 131,956 files here and 3.5s for 594,511 in a research repository. Its
global freshness sweep also measured 135ms for 10,845 directories against 220ms
to rebuild. Those results ruled out repairing the flat set with another Git
enumeration or a wider sweep.

The replacement test suite covers ignored membership, same-timestamp creation,
absolute and parent-traversal rejection before I/O, cache bounds, default and
project-defined warm exclusions, `.git`'s unconditional exclusion, malformed
`.yepignore` fallback, HTML safety, self-link suppression, and batch I/O cost.

A 2026-08-02 end-to-end measurement used the motivating ignored file under
`trtllm-speculative/draft`: 10,000 highlighted tokens, 191 distinct candidates
in one parent directory, and 500 occurrences of the existing file.

| state | elapsed | `stat` | `readdir` | links |
|---|---:|---:|---:|---:|
| cold trie | 22.3ms | 8 | 4 | 500 |
| cached parent, median of 5 | 9.4ms | 1 | 0 | 500 |

The five cached-parent timings ranged from 7.0–11.2ms. This is a local
regression measurement, not a cross-machine latency guarantee; the structural
result is the stable part: 10,000 tokens and 191 distinct candidates in one
directory required one validation `stat`, with no global tree sweep.
