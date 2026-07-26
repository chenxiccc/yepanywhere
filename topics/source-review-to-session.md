# Source Review → New Session

> A read-only source-control/repo viewer whose primary job is directing
> agents, not managing git. In a large-screen multipane layout you navigate
> the working-tree diff and recent commit(s) and — Gerrit/GitHub style —
> **click a diff line to open a comment window**. You do not select an exact
> span; nearby context is implied. Comments accrue as drafts across files and
> diff lines while the tree keeps changing under them; "submit review" drains
> **every not-yet-consumed comment at once** into one review session — a new
> one, or a recent review session as a follow-up turn — and archives them as
> consumed. Comments accumulate **client-side initially** (simplest to build);
> server-side draft persistence is a later enhancement. A mobile back-swipe
> version (with a small commit-jump selector) is usable too. No git write
> actions from this surface; agents keep doing the commits/merges.

Topic: source-review-to-session

Status: **proposed, not implemented** (2026-07-25; design refined 2026-07-26).
Design owner: graehl.

Related topics: [selection-comment-ui](selection-comment-ui.md) (the
quote-comment ancestor — but see the gesture difference below),
[floating-new-session-composer](floating-new-session-composer.md) (the
first-turn launch path), [local-file-source-highlighting](local-file-source-highlighting.md)
(highlighted read-only file previews),
[forged-transcript-handoff](forged-transcript-handoff.md) and
[session-context-actions](session-context-actions.md) (seeding a session with
prepared context), [provider-context-economics](provider-context-economics.md)
(cost of quoted code), [compose-time-context-anchors](compose-time-context-anchors.md)
(staleness/provenance framing for composed turns).

## Origin

Prompted by [kzahel/yepanywhere#95](https://github.com/kzahel/yepanywhere/issues/95):
a contributor shipped a polished file browser plus full git management (branch
switch, log, changes, stash, history, fetch/commit/push). kzahel deliberately
kept YA's git surface minimal — pull/push/refresh only — because he lets agents
do committing and conflict resolution and rarely takes manual git actions. The
contributor then named the part that actually earns its keep: the viewer is a
**bridge for directing agents**, not a repo-management console. Their two live
use cases were (1) grab exact file names / relative paths to feed an agent, and
(2) read the git log to grab a branch name or commit hash so they can tell the
agent "look at what changed in *this* commit and adapt."

This proposal takes that bridge framing as the whole point and adds the piece a
detailed reviewer wants: **comment on diff lines, then hand the whole review to
a fresh agent** — the review-tool interaction (Gerrit/GitHub line comments)
minus any obligation to perform the git actions yourself.

![3-column recent-changes browser (kzahel/yepanywhere#95)](https://raw.githubusercontent.com/chenxiccc/yepanywhere/assets/screenshots/source-manager/git-management-04.webp)

*Reference layout (kzahel/yepanywhere#95, the contributor's Source Manager): a
3-column recent-changes browser — commit list · changed files · unified diff. A
side-by-side diff option would make it 4 columns. Linked to the upstream asset
rather than committed, to avoid polluting the repo.*

**Reference implementation, not a template.** The issue #95 submitter's
archived
[`source-file-manager-v3` branch](https://github.com/chenxiccc/yepanywhere/tree/archive/source-file-manager-v3)
is useful for interaction and layout inspiration only. Do not copy it wholesale:
it is deliberately more feature-rich than YA's goals here, especially around
file and git management. Any borrowed idea must first pass this topic's
read-only, agent-directing scope.

## Design stance

- **Read-only by contract.** This surface never mutates the repo: no branch
  switch, commit, push, stash, or merge. Those stay with agents (kzahel's and
  graehl's shared stance — dumb ff-only pull at most, agents do the rest). The
  viewer only *reads* and *copies*, and its one write is composing a new session
  prompt. Read-only is what makes it safe to be featureful and polished without
  becoming a second, fallible git client.
- **Compose, don't act.** The output of a review is never a git operation; it is
  a **review session turn** — a new session, or a follow-up to a recent review
  session — carrying the reviewer's comments and the code they were about. The
  reviewer directs; the agent acts.
- **One surface, two modes — both accumulate.** "Source control" is a single
  surface with two navigation modes that feed the **same** comment accumulator:
  (1) the working-tree (uncommitted) diff and recent commits / diffs (the
  primary review flow — reviewing an agent's dirty worktree *before* it commits
  is the hottest supervision moment), and (2) an **all-files
  git-blame browser** — open any project file, not just recently-changed ones,
  with blame giving each line its originating commit. Clicking a blamed line
  opens the same comment window. The all-files browser is a subsection/mode of
  source control, **not a standalone feature**.
- **Line comments, implied context — no precise selection.** You click a diff
  line to open a comment window; you do **not** drag-select an exact span to
  limit context. It is implied that the nearby context is what the comment is
  about, and the tool includes it. This is deliberate: hand-delimiting spans is
  friction, and "the code around this line" is almost always the intent. The
  payload carries a small immediate snippet inline plus references for larger
  context (see the seeded-turn contract below), never a reviewer-chosen span.
- **Large-screen, multipane — with a first-class mobile path.** The design
  target is a smooth, large-screen multipane layout (like the #95 branch
  screenshots): navigate recent commit(s) in one pane, read a diff in another,
  comment on various diff lines as you go. Mobile is not an afterthought: a
  back-swipe-navigable version, with a small selector to jump between commits,
  stays usable for reading diffs and leaving comments on the go.
- **Build on existing surfaces, don't rebuild.**
  - [selection-comment-ui](selection-comment-ui.md) — select text → `>`
    blockquote into the composer with a green comment-anchor tint. It is the
    quote-comment *ancestor*, but the gesture here differs: **click a diff line →
    comment window**, not drag-select, and the destination is a persistent
    pending review, not the live draft. The comment-anchor tint (marking a line
    that already has a draft comment) still applies.
  - `GitStatusPage` / `GitStatusDiffPreview` / `routes/git-status.ts` — the
    existing read-only status + diff viewer to grow the multipane commit/diff
    browsing from.
  - [local-file-source-highlighting](local-file-source-highlighting.md) —
    Shiki-highlighted previews via the authenticated local-file route, for the
    file-viewer half and the highlighted diff.
  - Path/link affordances graehl noted: any path mentioned in a session is
    already viewable and any file link is already copyable — the viewer makes
    those first-class rather than incidental.
  - [floating-new-session-composer](floating-new-session-composer.md) — the
    launch path a submitted review reuses.

## Core feature: the accumulating review (the vision)

This is the actual proposal, not the one-off below. It is a Gerrit-style set of
**draft comments that persist and accumulate** — across files, across diff lines
within a commit, and across the tree as it keeps changing under them — until a
single "submit review" drains *every not-yet-consumed comment at once* into one
review session. The value is that a reviewer works over a change at their own
pace, leaving line comments as they go, and only later hands the whole
considered review to an agent in one shot.

There is deliberately **no Gerrit-style patch-set or change-identity concept**:
plain git has no stable identity for "the same change" across amends and
successive commits (no Change-Id machinery here), and everything patch-sets
would buy is already covered by per-comment anchoring revisions plus
submit-time relocation below.

- **Comment on a line.** Clicking a diff line — on either the `-` (removed) or
  `+` (added) side — or a blamed line in all-files mode opens a comment window
  anchored to that line; its provenance follows the rules below. No exact-span
  selection; the tool carries a small immediate snippet and references for the
  rest (see the seeded-turn contract).
- **Anchors and drift.** Each comment anchors to `{ repo-relative path,
  anchoring revision, line, nearby-context snippet }`. The anchoring revision
  is one of: the reviewed commit's SHA, the blame line's origin SHA, the HEAD
  SHA at comment time (the all-files "as of HEAD" case), or **uncommitted** —
  a working-tree change with no SHA, labeled `uncommitted` and timestamped.
  Drafts live for hours or days while agents keep committing, so anchors
  drift: lines move, change, or vanish. At **submit time, per comment**, the
  anchor is relocated against the current tree — exact line match first, then
  a fuzzy context-snippet match (patch-hunk style). An `uncommitted` anchor
  whose change has since been committed acquires that commit's SHA and
  relocates the same way.
- **Provenance, and when the generated message cites a SHA.** The generated
  message states the SHA **only when relocation fails** — the commented line no
  longer exists in the current tree, so the agent needs the commit to locate
  the historical line. When relocation succeeds, the message omits the SHA and
  gives path + current line + snippet; the agent can run `git blame` itself if
  it wants provenance. This keeps the seeded turn lean and only cites commits
  the agent actually needs. A comment on the `-` (removed) side of a diff is by
  definition about code no longer in the tree, so its SHA is **implied and
  always cited** (a concrete case of the relocation rule). For diff comments
  the message can also frame the change as *from X to Y*, where X and Y are the
  clicked line plus a few surrounding lines in the old and new versions
  respectively — so the agent sees the before/after region, not just the single
  side that was clicked.
- **Submit preview; stale comments default to discard.** "Submit review" first
  shows a preview of every pending comment. Comments whose context no longer
  exists (relocation failed) are listed **first**, pre-selected **discard** —
  it is usually too late to act on them — but the reviewer can override and
  include any of them (each then carries its SHA citation), since discussion
  of history can still inform present state.
- **Pending → consumed (archived) lifecycle.** A comment is *pending*
  (unconsumed) from creation until a review is submitted. Submit gathers the
  pending comments that survived the preview, composes one review turn,
  delivers it, and **archives** those comments as consumed: they stay visible
  on their anchors and in an archive list, linked to the session they went to —
  so "did I already comment on this?" has an answer — and the next submit will
  not resend them. Comments added afterward form the next pending review. A
  visible pending count (like unsent Gerrit drafts) is the reviewer's cue to
  what a submit would carry.
- **Submit target: recent review session by default.** When a review session
  was recently started from this surface, submit defaults to delivering the
  new batch to it as a **follow-up turn** — that agent already holds the
  earlier review context. The submit flow lets the user override: pick any
  existing session manually, or opt for a fresh one (launched via the floating
  new-session composer). "Recent" is a default, not a gate; each consumed
  batch records which session it went to.
- **The seeded turn: short prompt + review file, small snippets inline.** The
  delivered turn is a short prompt — naming what this is (a source review),
  instructing the agent to address each comment and report per-comment
  dispositions, and explicitly instructing it to read current file state
  rather than trusting quoted snippets — referencing a **project-local `.yep`
  review-comments file** that carries the structured comments (a follow-up
  turn references the same file updated with the new batch). Each comment
  gives path + line + anchoring revision plus a **small immediate snippet
  inline**: inline context lets a human reading the transcript comprehend the
  review, and makes the agent less likely to miss the immediate context — at
  the known risk that the agent settles for the snippet instead of reading the
  larger context, which the read-current-state instruction counters. Larger
  context stays by reference; for a non-current revision the agent views it
  with git commands.
- **Where drafts live.** Initially a **client-only accumulator**
  (`localStorage`, like message drafts), **keyed per project from v1** so two
  repos' drafts can never drain into one session — the preferred v1 because it
  is the simplest to build; drafts are then per-browser and lost on clear.
  Server-side draft persistence (surviving across devices and reloads, with
  authoritative consumed/archived state) is a later enhancement, not v1.
  Consume-on-submit semantics are identical either way; only durability and
  the cross-device story differ.

## One-off diff-line comment → new session (a fast path, not the vision)

A direct "click a line, comment, start a session with just that now" shortcut
is worth having for a quick single question. It is **defined as the accumulator
containing one comment, drained immediately** — same store, same submit
machinery, just a "submit now" button beside "add to review" in the comment
window — never a parallel code path. Submitting it consumes only that one
comment, leaving the rest of the pending review untouched. Do not mistake
shipping this shortcut for delivering the accumulating review — the vision is
the multi-comment, drain-all-unconsumed flow.

## Read-only repo viewer scope

The polished viewer graehl wanted, kept strictly read-only:

- **Repo/branch status bar.** A small persistent top bar naming the repo and
  current branch, with a **yellow warning when the worktree is dirty or the
  branch is out of sync** (ahead/behind its upstream). It consolidates the git
  ops YA's source-control surface **already** exposes against upstream/origin
  (fetch and friends) into one always-visible header — surfacing status, not
  adding new mutating actions; the write actions in Non-goals stay excluded. A
  reasonable concept on large screens especially, but useful at any width.
- Multipane commit/diff navigation: browse the working-tree (uncommitted) diff,
  recent commit(s) and history/log, and a commit's diff **without switching
  branches** (extends GitStatusDiffPreview, which is already the working-tree
  diff viewer).
  The reference layout above is a **3-column** browser (commits · files ·
  unified diff); an optional **side-by-side diff** makes it **4 columns**. From
  a commit's diff you can switch to an **"as of HEAD" content view centered on
  the diff region, with a blame gutter** — bridging the commit-review mode into
  the all-files/blame provenance.
- Rudimentary search across recent commit **delta (diff) text and/or filenames**
  — enough to find the commit or file you want to comment on. This is a generic
  browser facility, captured here as part of this surface by design intent.
- All-files mode: file tree + search + highlighted file viewing (reuse Shiki per
  local-file-source-highlighting), with **git blame** so any line can be clicked
  to comment into the same review — a mode of this surface, not a standalone
  browser.
- Copy affordances: file name, absolute path, relative path, branch name, commit
  hash — the non-mutating subset of the #95 context menu.
- Mobile: a back-swipe-navigable version with a small commit-jump selector,
  usable for reading diffs and leaving comments on the go (the #95 branch showed
  mobile matters).

## Non-goals

- No git write actions from the UI (branch switch, commit, push, stash, merge,
  rename/delete files). If a repo change is wanted, it is phrased as a comment to
  an agent, not performed here.
- No precise span selection to limit context — anchoring is per-line with implied
  nearby context, by design.
- Not a replacement for agent-driven git; not a full IDE or a second VS Code; not
  a general file manager (the #95 rename/delete items are out by the read-only
  contract).

## Design decisions

- **Uncommitted provenance class** (vs. commit-only anchors): the hottest
  supervision moment is reviewing an agent's dirty worktree before it commits,
  and the existing GitStatusDiffPreview foundation is exactly that view; an
  anchor class with no SHA (labeled `uncommitted`, timestamped) covers it.
- **Submit-time relocation, SHA cited only on failure** (vs. citing every
  comment's commit): lean seeded turns; the agent needs a SHA only when the
  line is gone from the current tree.
- **No patch-set/change-identity concept** (vs. Gerrit-style revisions): plain
  git has no stable change identity across amends and successive commits;
  anchoring revisions plus relocation cover draft survival.
- **Stale comments default to discard at submit preview** (vs. silently
  including or dropping them): usually too late to act on, so pre-selected
  discard and listed first — but overridable, since discussion of history can
  inform present state.
- **Default submit target = recent review session** (vs. always a new
  session): round-2 comments continue the round-1 conversation; the submit
  flow still lets the user pick any existing session or a fresh one.
- **Archive consumed comments** (vs. delete): answers "did I already comment
  on this?", keeps history, and links each batch to the session it went to.
- **Short prompt + project-local `.yep` review file, small snippets inline**
  (vs. pasting full context into the turn): the structured comments travel in
  a file the prompt references, keeping the transcript readable; small inline
  snippets serve human comprehension and immediate-context safety, and the
  prompt instructs the agent to read current file state rather than trust
  them.
- **Blame cache keyed by (commit SHA, path)** (vs. mtime keying, vs. a
  cumulative all-history blame index): blame is a pure function of (commit,
  path); mtime false-invalidates on touch and can miss same-second edits; a
  cumulative index is probably too large. Dirty files have no SHA for current
  content, so they key on a content hash — or mtime as the cheap freshness
  check — or skip caching.

## Open questions

- **Provenance rendering.** Reuse the compose-time-context-anchors framing so
  each quote's SHA/age is legible to both the reader and the agent.
- **The `.yep` review-file details.** Exact path/name, format, and whether it
  is committed or gitignored; how a follow-up turn's update composes with the
  archive.
- **Server draft schema.** When drafts graduate from client storage to the
  server: keying (project + comment anchors), and how archived comments are
  pruned.
- **Relationship to forged-transcript-handoff.** A submitted review is a
  narrower, reviewer-authored cousin of that experiment — worth deciding whether
  they share the seeding path.

## Staged plan

1. **One-off line comment → new session.** Add click-a-diff-line → comment on
   the git-status/diff viewer — which is the working-tree diff, so this slice
   already exercises the `uncommitted` anchor class. Built as the single-entry
   accumulator drained immediately (per the fast-path definition above), it
   proves the line-anchor + provenance payload with no parallel code path.
2. **Accumulating review — the vision (client-only accumulator).** Persist
   pending comments in project-keyed `localStorage` across files and commits
   with a visible count; "submit review" runs the preview (stale comments
   pre-selected discard), drains the survivors into the target session
   (recent review session by default, override to any or new), and archives
   them consumed. Client-only is the deliberate v1 for build simplicity.
3. **Fuller multipane viewer + all-files blame + search + mobile.** Wrap the flow
   in the large-screen multipane commit/diff/file viewer with the copy
   affordances, the all-files git-blame browsing mode, rudimentary
   commit-delta/filename search, and the mobile back-swipe + commit-jump path.
4. **Server-side drafts (later enhancement).** Move drafts server-side for
   cross-device durability and authoritative consumed state, once the
   client-only accumulator has proven the flow.
