# Project path links in viewed content

> A bare project-relative path appearing in file content is a link, because it
> names a file that exists here — not because it looks like a path.

Topic: project-path-links

Status: **partially implemented; the index is being replaced.** Linkification
of the file viewer's highlighted source works (2026-08-02). The path index
behind it does not yet meet this topic's own contract: it misses gitignored
files, which is the case the feature exists for, and its validation stops being
live on a wide repository. *Membership decides linking* and *rendering* below
are current and hold; **The index** below describes what shipped, and is
superseded — see *Index rebuild* at the end.

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

`packages/server/src/projects/projectPathIndex.ts` holds one path set per
project.

**Untracked files are indexed**, not just `git ls-files` output. The reported
case is a manifest pointing at `untracked/pii-eval/prod/…jsonl`; a
tracked-only index would fail exactly the paths worth linking. The set is
therefore tracked paths plus porcelain-v2 untracked paths.

Its size bound is a backstop against a pathological tree, not a working limit,
and is deliberately far above the Source Control browser's 10,000-path corpus
bound — that one caps what a human scrolls, this only holds strings for
membership tests. A real repository here measured 15,365 paths, so a
10,000 bound silently dropped files that should have linked. Untracked paths
are inserted first, so if the backstop ever truncates it keeps the paths
nothing else can supply: tracked files stay reachable through Source Control's
file browser, while an untracked run output is only ever named in content like
the manifest this feature exists for.

**Staleness is directory mtime.** A directory's mtime moves when an entry is
created, removed, or renamed inside it — precisely the changes that make a link
appear or dangle. Editing a file's *contents* does not move it and does not need
to. The index re-stats its known directories, no more often than a floor
matching the Source Control status poll, and rebuilds when any differs. A check
that finds nothing changed advances that floor, so a quiet project is swept once
per window rather than on every view.

The watched-directory cap is set where the sweep stops being the cheaper
option. Measured on a 10,845-directory repository: 135ms to stat them all
versus 220ms to rebuild outright — close enough that sweeping buys nothing. A
project past the cap therefore keeps no watch set and rebuilds on a much longer
interval instead, trading staleness for not paying either cost on a request the
reader is waiting for.

This is deliberately not a filesystem watcher. A watcher would also serve
Source Control's dirty-state refresh and is the better long-term answer, but it
is involved and platform-sensitive, and directory mtimes carry this feature on
their own. `invalidateProjectPathIndex` exists for callers that already know the
tree moved — a completed file mutation, a branch change — so a watcher or the
dirty-file editor observer can drive it later without changing the contract.

## Rendering

Linkification runs server-side over already-highlighted HTML, in the same
response that produces it, so the client needs no path corpus and no second
request. Matches are wrapped in the same `renderLocalFileLink` markup the
Markdown viewer emits, so the existing `data-ya-resource="local-file"`
interception opens them in the same popup.

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

## Index rebuild: per-directory validation

The index described above is a flat path set validated by re-stat'ing every
directory it knows. That is being replaced, for two reasons found by checking it
against a real repository rather than a constructed one.

**It misses gitignored files.** Its sources are `git ls-files` and
`git status --untracked-files=all`, and neither reports ignored paths. Run
outputs — the content this feature exists to make navigable — commonly live
under a gitignored directory. Enumerating ignored files up front is not the
answer: measured 2.5s for 131,956 files here (mostly `node_modules`) and 3.5s
for 594,511 in a research repository.

**Global validation costs as much as rebuilding.** On a 10,845-directory
repository, stat'ing every directory took 135ms against 220ms to rebuild
outright, so the sweep bought nothing and the implementation degraded to a long
TTL at exactly the width where staying live matters.

The replacement keys the structure by path component, one node per directory,
each holding the child listing and the directory mtime observed when that
listing was read. A directory's mtime changes exactly when its own entries
change — verified: adding, deleting and renaming an entry all move it, while
editing a file's contents does not, and a change inside a subdirectory does not
move the parent's. Membership of `a/b/c.json` therefore needs only `a/b`'s
listing to be current, so **one stat of `a/b` validates the answer**, presence
or absence alike.

Three properties follow, and each is a requirement of the replacement rather
than an optimization:

- Cost scales with the distinct directories a piece of content references, not
  with how many candidate tokens it contains, because a validated directory node
  answers "not here" without I/O.
- Ignored files are covered, because `readdir` does not consult `.gitignore` and
  nothing is enumerated up front.
- Freshness needs no TTL, because validation is per lookup rather than a sweep
  that has to be rationed.

Directory watches (inotify) remain the escalation on top of this, not a
prerequisite — and are the same signal Source Control wants for refreshing dirty
state.
