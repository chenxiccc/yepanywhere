# File path links in viewed content

> A bare path appearing in authenticated viewed content becomes a file-viewer
> link only after the server proves that exact file exists within the applicable
> file-access boundary.

Topic: project-path-links

Status: **implemented (2026-08-02); demand-driven cache and turn-text
annotation landed 2026-08-05; authenticated absolute-path probes landed
2026-08-10; command, tool-result, and user-turn annotations landed
2026-08-16; viewed-file-relative and external-file-relative links landed
2026-08-25.**
Highlighted file content, assistant turn text, completed command text, and
completed tool-result bodies link exact project files through a demand-driven,
watcher-backed directory cache — the same cache that now also decides the
inline-code file references turn text already linked. Tracked, untracked, and
gitignored files share the same membership test. The breadth-first warm, the
per-use directory-mtime validation, and the `.yepignore` crawl exclusions this
feature originally shipped with are gone.

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

**Absolute paths use a separate exact oracle.** A whitespace-delimited POSIX
token beginning with one `/`, or a Windows token beginning with a drive letter
and separator, is eligible for one direct file probe when it contains at least
four characters. The whole token is queried, including legal punctuation, so
an existing prefix is never linked out of a longer filename. It is never added
to the project index or discovered by a filesystem crawl.
The probe uses the same realpath-resolved allow-set and regular-file check as
the authenticated file endpoint, and click-time fetching repeats that check.
At most 64 distinct direct-filesystem candidates are probed for one completed
body, shared between explicit absolute paths and paths resolved relative to an
external viewed file. Short absolute tokens such as `/x`, network-style
`//...` tokens, missing files, and files outside the configured allow-set
remain plain text.

This absolute-path resolver is absent from both live and frozen public-share
rendering. Generated absolute links also carry the private-project-link marker
as defense in depth, so captured or reused authenticated HTML is unwrapped
rather than granting a share a path or file-existence capability.

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

**Each retained component edge records only what was proven** — `directory`,
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
the filesystem every time. A named event invalidates and removes an already-
retained edge; if the parent was complete, it also invalidates completeness.
Previously absent names likewise invalidate completeness without materializing
an `unknown` edge. Every named-event branch then closes the parent watcher when
no observation or cacheable fact remains. Event churn therefore retains no name
nobody queried, and a later answer is exact-probed. An event that names no entry,
a watch error, or overflow
instead makes the whole generation uncertain: the directory's cached facts are
discarded rather than trusted, and one bounded re-listing re-establishes them.
Invalidated names retain no edge; once no proven edge, complete listing, or wide-
listing fact remains, releasing the last current observation also releases the
watcher. Claims are exact watcher-identity and generation
tokens: an in-flight claim from a failed older watcher or generation cannot pin
its factless replacement. Every trie node also carries an attachment generation:
its object reference is usable only while root traversal still reaches that exact
node at its canonical path with the same generation. One subtree-invalidation
operation advances that identity and releases the node's own watcher and
reconciliation timer plus every descendant. A parent event naming a directory
uses that operation before removing the named edge, so a replacement inode
cannot inherit the old directory's watcher or timer. Removing an edge also marks
the old node detached. A deferred reconciliation is
therefore cancelled when its node is replaced or removed with an evicted
subtree, and can neither retain nor mutate an unreachable cache node.
Reconciliation that does publish on a still-reachable node performs the ordinary
byte-budget enforcement before settling. Watch ambiguity therefore cannot leave
a negative answer trusted indefinitely.

An exact probe attaches or claims the parent-directory watcher and captures its
live generation before `lstat`. The lookup also captures the registry activity
generation belonging to its owning project claim. It publishes the result only
if the project is still in that same activity and the same watcher generation
remains live and unchanged after the read. A watcher-generation change earns
one retry under the new observation; a last release or later reclaim instead
turns the completed read into an uncached answer and never attaches a watcher
for the obsolete activity. If two watcher generations change, one final direct
`lstat` answers the caller without caching. The probe never loops. Each attempt
releases its temporary watcher claim on every exit,
including permission-denied and thrown reads; a successful positive cache entry
or exact negative cache entry then retains the watcher as the fact's owner, while
an uncached answer leaves no otherwise-empty watcher behind. An unwatchable
parent returns the direct answer without caching, and a missing directory
component terminates the walk after observing only its nearest existing parent.
Before every retry, the probe reacquires the currently attached parent by
canonical path from the root. If ancestor invalidation detached the node, the
retry returns a direct uncached answer; it never reattaches or publishes through
the stale object.

A directory listing uses the same ownership, attachment, and generation fence.
It reacquires the canonical directory node, claims its watcher before `readdir`,
holds that exact watcher alive through the read, and publishes a complete or
wide-directory fact only while root reachability, attachment generation,
watcher, watcher generation, and registry activity generation all remain
current. A coalesced waiter rechecks that observation before using or retaining
the listing. If any identity changed, the requested names are exact-probed under
the lookup's original activity; an obsolete activity therefore gets correct
direct answers but cannot publish the stale listing or its fallback probes into
a replacement claim. Reconciliation timers carry the same canonical path,
attachment generation, and activity generation and recheck all three before
they read or publish.

**Probe or list, whichever is cheaper for the batch.** One lookup batch groups
candidates by parent directory. A sparse set is probed exactly with `lstat` —
`lstat`, not `stat`, so a symlink is a leaf and a link cannot walk the
traversal out of the project. Four or more unknown names in one not-yet-complete
directory are worth a single `readdir` instead, which then answers every later
name in that directory. **The four are counted cumulatively, not per batch.**
Each directory remembers how many distinct names it has probed since its
generation began, and a batch that pushes that running total over the threshold
earns the listing. One wide batch is not the only way to deserve one: turn-text
annotation asks about two or three names per rendered body, so on a per-batch
test alone a directory the reader keeps referring to would pay an `lstat` per
name forever. Discarding the generation resets the count with the facts it
proved. A listing wider than 20,000 entries is not retained
whole — one directory would otherwise claim a large share of the project's
entire budget — but the names that batch asked about are kept as ordinary
proven edges, since the watch was already attached when the read covered them.
The width itself is remembered, so later batches in that directory probe
exactly instead of re-reading it every time; the cap therefore bounds what may
be *claimed complete*, not what may be known. Discarding the directory's
generation forgets the width too, so a directory that has since shrunk is
listed again rather than probed forever.

**Retention is bounded at both owners.** Within a project, least-recently-used
hydrated directories are dropped once retained bytes exceed 4 MiB. One index
also has a hard ceiling of 1,024 watchers even while actively claimed. Before a
new attachment at that ceiling, it evicts least-recently-used directory
subtrees that own neither the current traversal nor any in-flight observation;
if all candidates are protected, the new read stays uncached rather than
closing a claimed watcher or crossing the ceiling.

Across the process, `getProjectPathIndex()` hands each caller a refcounted claim.
Inactive projects are dropped least-recently-used when the registry exceeds 128
projects, 1,024 live watchers, or 32 MiB; a triggered bound evicts toward its 75%
low-water mark. Bytes remain a separate bound rather than a proxy for tiny
watched indexes. Every self-consistent retained-byte or watcher mutation notifies
the registry, so growth in an active project immediately evicts eligible
inactive victims rather than waiting for a later claim or release. Active
claims themselves stay pinned under process pressure, and releasing the claim
makes the complete index — including every watcher — evictable.

The active-to-inactive transition advances one activity generation and cancels
pending reconciliation timers. Exact probes, ordinary listings, their watcher
observations, and reconciliation already awaiting I/O all carry that generation,
so neither a last release nor a release-and-reclaim lets prior work publish or
regrow facts and watchers into the inactive or replacement activity. A later
claim rebuilds state on demand. Ten thousand dormant projects therefore cannot
mean ten thousand live tries or watchers, and a discarded project still answers
by rebuilding only the components it needs. Byte eviction runs only between
batches, so a probe in flight keeps its ancestors; watcher-slot eviction applies
during attachment but protects that traversal and all current observations.

`projectPathCacheDiagnostics()` reports project count, retained bytes, live
watchers, and evicted projects; per-index counters cover cached answers, exact probes,
directory listings, oversized listings, watcher invalidations, uncertain
generations, and evicted directories. Reading either scans no tree.

`sourceRevision()` exposes one process-monotonic identity for rendered-output
fencing. A new or replacement index starts with a fresh identity. Named watcher
invalidation, uncertain watcher state, a probe that changes an already-observed
membership fact, disposal, and loss of a watcher that owned retained facts all
advance it. Render work observes the identity before filesystem-dependent work
and verifies it again before retaining output. A direct answer from an
unwatchable directory or synchronous `stat` fallback is deliberately marked
unversioned: callers may use and coalesce that answer, but must not retain
rendered output derived from it.

**Completion is an explicit request, not a side effect.** The replacement plan
sketched an optional `listDirectory()` on the interface; it is deliberately
unbuilt, because no product surface asks for a complete inventory. A surface
that later needs one must request and budget that operation, never restore it
to index construction. The same rule retired the `.yepignore` crawl-exclusion
file with the warm it configured.

## Rendering

Path discovery is advisory and must never gate the first readable source or
preview. A file response renders highlighted and Markdown text from already
known path facts; cold project-root, viewed-file-relative, and authenticated
absolute-path probes continue outside that display-critical response. The
current view may therefore stay plain and a later refresh may gain anchors.
This is the viewed-file form of the established session-text contract: live or
optimistic text appears before its settled, server-confirmed path annotation.

Foreground linkification runs server-side over already-highlighted HTML using
only cached membership facts, so the client needs no project path corpus and a
cold scanner cannot extend response latency. After constructing the response,
one deferred pass collects distinct candidates. The project index resolves
relative candidates in bounded directory batches, while the authenticated
allow-set resolver directly probes bounded absolute candidates. That pass
warms the authoritative caches; it does not mutate the response already being
returned. A later request rewrites only confirmed files. Project-relative
matches retain the existing local-file markup; absolute matches use private
project-file markup so both open in the FileViewer belonging to the active
session project.

Highlighted file content also resolves relative tokens from the viewed file's
containing directory when the same token is not an existing project-root path.
Project-root precedence preserves every established link when both coordinates
exist. A leading `$ROOT/` is treated as an explicit relative-root marker: the
marker is removed, then the same project-root-first, viewed-directory-second
resolution applies. This covers configuration values such as
`$ROOT/input/example.txt` without teaching the viewer a project-specific file
format. Turn text and tool annotations have no viewed-file coordinate, so their
project-root-relative contract is unchanged.

When the viewed file itself is an allowed absolute file outside the selected
project, relative tokens resolve from that file's directory through the same
authenticated allow-set and regular-file oracle as explicit absolute paths.
The unrelated selected-project index is not queried. If every distinct token
fits the body's remaining 64-probe budget, all are checked once; repeated
occurrences share that answer. For a larger body, only tokens with a path
separator, a leading dot, or a plausible extension are eligible, and the same
cap still applies. Confirmed targets use private project-file viewer links;
public shares receive no external resolver and cannot discover these files.

All possible targets for one body enter the same `findExisting()` batch. The
index therefore answers cached negative prefixes immediately and groups dense
root or sibling-directory candidates into its existing bounded directory
listing; file-relative support adds no per-token `stat` loop and no project
crawl. Self-link suppression applies to the resolved target rather than only
to the visible spelling.

Constraints that keep it safe over arbitrary markup:

- Only text between tags is rewritten. Markup is never matched, so a real
  project path appearing inside a tag attribute cannot corrupt the HTML.
- Text already inside an `<a>` is left alone. Highlighted source contains no
  anchors, but rendered turn text does — from Markdown links and from the
  inline-code file linker — and an anchor nested inside an anchor is not markup
  a browser can be asked to render.
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

## Design decisions

- **Project-root paths win collisions** (vs. nearest-file precedence): adding a
  sibling with the same name cannot retarget an existing project-relative link.
- **Expand bounded target aliases into the existing index batch** (vs. client
  path corpora or a second filesystem oracle): the watcher-backed index keeps
  membership, invalidation, and I/O batching authoritative in one place.

## Turn text

Assistant prose runs the same seam, wired at `renderMarkdownToHtml`
(`packages/server/src/augments/markdown-augments.ts`) — the one funnel both
render paths share, the streaming coordinator's completed-block render and the
settled/replayed `augmentTextBlocks`. Per completed body, never per streamed
delta: the coordinator's per-delta path goes through the synchronous
`renderSafeMarkdown`, which reaches no filesystem. Callers claim the index for
the right lifetime — one claim for a session subscription's augmenter, per
request in `routes/sessions.ts` — and a claim that fails yields plain text
rather than an error.

**One oracle, not two.** Turn text already linked a subset of paths before
this: `resolveProjectFileCodeReference` links assistant *inline-code* filename
references, and decided membership with a blocking `statSync` plus an
unbounded, never-invalidated module map. Two oracles for one question can
disagree, and that one had no way to learn a file was deleted. The trie is now
the authority; `statSync` remains only as the backstop for what the trie cannot
prove, which is the same degradation the index already uses when a watch is
unavailable. The module map memoizes only that backstop — layering it over the
trie would let an answer outlive the fact behind it.

Rendering asks synchronously, so one batched asynchronous pass over the raw
source runs first (`resolveShapedPaths`) and turns the mid-render questions
into cache hits. Batching is also what lets a directory be listed once instead
of probed per name. `PATH_TOKEN` excludes `:`, so an inline `src/server.ts:42`
already tokenizes to the `src/server.ts` key the inline-code path needs.

**Gate relative-path I/O, not linking.** In prose most words are words, so a token earns a
filesystem call only by shape: it contains `/`, starts with `.`, or ends in a
short alphanumeric extension containing a letter — which keeps `1.2.3` a
version. A token failing that test is still *answered* from what the cache
already holds, so `Makefile` and `LICENSE` link wherever their directory is
already listed and only an unlisted one goes unlinked. A token starting with
`/` never enters this project-index path; eligible absolute tokens go through
the separate bounded allow-set resolver described above. The file viewer leaves
the relative-path shape gate off — every token there came out of a file the
reader is already looking at, and one batch groups them by directory anyway.

The gate is a shape test, not a character-level automaton over the trie. The
early-fail property is already present at component granularity: a token whose
first component is a cached `absent` costs one cache hit regardless of its
length. Scanning character by character would save regex and allocation work,
not the filesystem I/O that is the actual cost.

## Tool commands and result bodies

Completed authenticated tool-use command strings and string tool-result bodies
carry a small optional `_projectPathLinks` annotation containing only exact
tokens the server confirmed. The annotation is per body, not a project path
corpus. Bash/Ran command headers, collapsed previews, expanded output, and the
detail modal all consume the same annotation. A missing target remains ordinary
text even when a glossary term inside that text is independently annotated.

A confirmed full path is one anchor. Glossary annotation does not enter an
existing anchor, so it cannot split or replace the file link. Source/raw mode
may show the original plain text; rendered mode owns the link. The command row
uses a delegated keyboard/click target instead of wrapping its contents in a
native button, allowing file anchors and the row's expand action to coexist.
Activating an anchor does not expand the row or open the Bash detail modal.

The field is optional and field-presence-gated. Servers without it preserve the
previous plain rendering and receive no new request. The compatibility review
covered stable releases `v0.7.0` and `v0.6.2`; neither supplies the annotation.
Public-share routes do not produce it, and public-share rendering ignores it if
it is present in reused content, preserving the no-file-existence-oracle
boundary.

## User turns

Completed authenticated user messages carry the same bounded, optional
`_projectPathLinks` annotation at message level. String prompts and text blocks
are resolved as one visible body; attachments and other structured blocks do
not become path text. The transcript projection passes only the confirmed
literal token/target pairs to the user-turn renderer. An optimistic prompt can
therefore begin as plain text and gain its file anchors when the server's
durable message arrives.

User-turn decoration has an explicit nesting order: a confirmed complete path
is one file-viewer anchor, a URL is one ordinary URL anchor, and glossary terms
are annotated only in the remaining plain-text segments. Neither glossary
matching nor URL matching enters or splits a file anchor. Missing annotations,
older servers, and public shares retain plain text and make no follow-up file
request.

## Version-control affordances

An authenticated project-file link may append two compact version-control
affordances after its path. The dirty affordance appears only when the current
Git status names that project-relative path and opens its working-tree diff.
The committed affordance appears only when the current HEAD commit names the
path and opens that commit's diff against its first parent with the file
selected. A file can show both. Ordinary activation stays in the current tab;
native modifier-click and context-menu behavior can open either link elsewhere.

These are capability-gated enrichments of an existing path link. An older
server receives no unsupported Git request, a non-repository or unmatched path
stays unchanged, and public-share file links never expose Source Control. The
status and HEAD-detail reads share retained request state across the many links
that can be mounted in one transcript and do not create one polling interval per
link. Edit-tool summaries use this same affordance instead of a separate review
link.

## Not yet covered

Assistant and user turn text, tool commands and results, and the file viewer's
highlighted source run this. Other viewers showing project content, such as
diff panes, would use the same server-confirmed annotation seam.

Completed Markdown HTML is retained behind a 32 MiB source-versioned
single-flight cache. Its exact key includes Markdown text, local-file scope,
inline-image mode, project identity/path, and custom membership-callback
identity. Only immutable HTML is retained; response messages are detached
before route-specific augmentation. Inline local images stay outside retained
HTML because their file bytes have no content revision fence. A project-path
revision change discards late work and forces a render under the new identity.

**Server annotation, not a client corpus.** Turn text raised the option of
shipping the path set to the client and matching there, the way glossary
tooltips ship a compiled automaton
([glossary-tooltips](glossary-tooltips.md) § Compiled matcher contract). That
was considered and rejected in 2026-08-05 design discussion. The path set is
three to five orders of magnitude larger than a glossary's — 131,956 files here
and 594,511 in a research repository — so the artifact is a different weight
class on a mobile-first client, and it is open rather than closed: any write
anywhere changes it, whereas glossary terms change only on an edit the
subscription already streams. Against that, a path link is decided once per body
the server is already rendering, so nothing needs re-deriving client-side.

Tool content follows the same decision without requiring server-side ownership
of its presentation: the server ships only the confirmed literal token/target
pairs for that one body, and the client inserts anchors while rendering the
existing command/output surface.

The general rule the two surfaces settle: ship the matcher client-side when the
pattern set is small, closed, and slow-changing; annotate server-side when it is
large, open, and filesystem-derived.

Server annotation also keeps the demand-driven cache sufficient. A shipped
corpus would require enumeration — the `git ls-files` set this feature's own
history rules out on correctness, since it omits the ignored run outputs that
motivated the feature — while the server only ever answers about text it is
currently rendering. So the mandate against a project-wide crawl stands
unamended.

## Replacement evidence

The original flat index used `git ls-files` plus porcelain-v2 untracked paths.
It missed ignored run outputs, while enumerating ignored files up front measured
2.5s for 131,956 files here and 3.5s for 594,511 in a research repository. Its
global freshness sweep also measured 135ms for 10,845 directories against 220ms
to rebuild. Those results ruled out repairing the flat set with another Git
enumeration or a wider sweep.

The replacement test suite covers ignored membership, sparse component-chain
I/O, listing-vs-probe batch choice, cumulative promotion across small batches,
absolute and parent-traversal rejection before I/O, concurrent-probe coalescing,
watcher invalidation, a forced watcher-uncertain generation and its
reconciliation, release/reclaim fencing around pending exact probes and ordinary
listings, unwatchable directories, oversized listings, per-project byte and
watcher ceilings, publication-triggered process eviction, process-wide
count/watcher/byte eviction, HTML safety, anchor nesting, the shape gate's lookup
budget, the extensionless name a listed directory still links, the inline-code
reference decided by the trie and the one that falls back to the filesystem,
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
