# Source Review → New Session

> A read-only source-control/repo viewer whose primary job is directing
> agents, not managing git. In a large-screen multipane layout you navigate
> recent commit(s) and their diffs and — Gerrit/GitHub style — **click a diff
> line to open a comment window**. You do not select an exact span; nearby
> context is implied. Comments accrue as drafts across files, diff lines, and
> patch-set revisions; "submit review" drains **every not-yet-consumed comment
> at once** into a single new agent session and marks them consumed. Comments
> accumulate **client-side initially** (simplest to build); server-side draft
> persistence is a later enhancement. A mobile back-swipe version (with a small
> commit-jump selector) is usable too. No git write actions from this surface;
> agents keep doing the commits/merges.

Topic: source-review-to-session

Status: **proposed, not implemented** (2026-07-25). Design owner: graehl.

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
  a **new session** whose first turn carries the reviewer's comments and the code
  they were about. The reviewer directs; the agent acts.
- **One surface, two modes — both accumulate.** "Source control" is a single
  surface with two navigation modes that feed the **same** comment accumulator:
  (1) recent commits / diffs (the primary review flow), and (2) an **all-files
  git-blame browser** — open any project file, not just recently-changed ones,
  with blame giving each line its originating commit. Clicking a blamed line
  opens the same comment window. The all-files browser is a subsection/mode of
  source control, **not a standalone feature**.
- **Line comments, implied context — no precise selection.** You click a diff
  line to open a comment window; you do **not** drag-select an exact span to
  limit context. It is implied that the nearby context is what the comment is
  about, and the tool includes it. This is deliberate: hand-delimiting spans is
  friction, and "the code around this line" is almost always the intent. How much
  nearby context to carry is an open question below, not a reviewer chore.
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
within a commit, and across successive patch-set **revisions** — until a single
"submit review" drains *every not-yet-consumed comment at once* into one new
session. The value is that a reviewer works over a change (and its revisions) at
their own pace, leaving line comments as they go, and only later hands the whole
considered review to an agent in one shot.

- **Comment on a line.** Clicking a diff line — on either the `-` (removed) or
  `+` (added) side — or a blamed line in all-files mode opens a comment window
  anchored to that line; its commit provenance follows the rules below. No
  exact-span selection; the tool carries the nearby context (see open questions
  for how much).
- **Provenance, and when the generated message cites a SHA.** Each comment
  anchors to `{ repo-relative path, anchored line, nearby-context snippet }` plus
  optionally a commit (the reviewed commit, the blame line's origin, or "as of
  HEAD" — no commit). The reason to keep a commit at all is to allow comments on
  **past commit state that has since changed**. So the generated new-session
  message states the SHA **only when the commented line no longer exists at
  HEAD** — there the agent needs the commit to locate the historical line. When
  the line still exists at HEAD (including the "as of HEAD" blame case), the
  message omits the SHA and just gives path + line + context; the agent can run
  `git blame` itself if it wants provenance. This keeps the seeded turn lean and
  only cites commits the agent actually needs. A comment on the `-` (removed)
  side of a diff is by definition about code no longer at HEAD, so its SHA is
  **implied and always cited** (a concrete case of the HEAD-existence rule). For
  diff comments the message can also frame the change as *from X to Y*, where X
  and Y are the clicked line plus N surrounding lines (before and after) in the
  old and new versions respectively — so the agent sees the before/after region,
  not just the single side that was clicked.
  (Different past revisions still keep their own SHAs internally, so a comment
  that *does* need one gets the right patch-set.)
- **Unconsumed vs consumed lifecycle.** A comment is *pending* (unconsumed) from
  creation until a review is submitted. "Submit review" gathers **all** pending
  comments — every file, every commit, every revision — composes one new-session
  first turn (per comment: the quoted line+context headed by its path + line,
  with its SHA cited only when that line is gone from HEAD — see provenance —
  then the reviewer's comment), launches it via the floating new-session
  composer, and marks those comments **consumed** so the next submit will not
  resend them.
  Comments added afterward form the next pending review. A visible pending count
  (like unsent Gerrit drafts) is the reviewer's cue to what a submit would carry.
- **Where drafts live.** Initially a **client-only accumulator**
  (`localStorage`, like message drafts) — the preferred v1 because it is the
  simplest to build; drafts are then per-browser and lost on clear. Server-side
  draft persistence (surviving across devices and reloads, with authoritative
  consumed/unconsumed state) is a later enhancement, not v1. Consume-on-submit
  semantics are identical either way; only durability and the cross-device story
  differ.

## One-off diff-line comment → new session (a fast path, not the vision)

A direct "click a line, comment, start a new session with just that now"
shortcut is worth having for a quick single question, and it reuses the same
line-comment/provenance primitive. But it is explicitly **not** the feature
above: it consumes nothing from the pending review and accumulates nothing. Do
not mistake shipping this shortcut for delivering the accumulating review — the
vision is the multi-comment, multi-revision, drain-all-unconsumed flow.

## Read-only repo viewer scope

The polished viewer graehl wanted, kept strictly read-only:

- **Repo/branch status bar.** A small persistent top bar naming the repo and
  current branch, with a **yellow warning when the worktree is dirty or the
  branch is out of sync** (ahead/behind its upstream). It consolidates the git
  ops YA's source-control surface **already** exposes against upstream/origin
  (fetch and friends) into one always-visible header — surfacing status, not
  adding new mutating actions; the write actions in Non-goals stay excluded. A
  reasonable concept on large screens especially, but useful at any width.
- Multipane commit/diff navigation: browse recent commit(s) and history/log and
  a commit's diff **without switching branches** (extends GitStatusDiffPreview).
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

## Open questions

- **How much nearby context per line comment.** The whole hunk, a fixed N lines
  around the anchor, or the enclosing function/block? This is the main knob the
  "implied context" stance creates; it trades legibility against
  [context economics](provider-context-economics.md).
- **Inline vs reference in the seeded turn.** Embed each quoted line+context as
  text, pass compact `path@sha:Lline` references for the agent to read on demand,
  or switch by size threshold. Large reviews pasted inline can be expensive.
- **Inline vs attachment.** Does the seeded turn embed the quotes as text or
  attach them (like uploaded context) so the transcript stays readable?
- **Provenance rendering.** Reuse the compose-time-context-anchors framing so
  each quote's SHA/age is legible to both the reader and the agent.
- **Blame caching.** `git blame` per file is expensive, and both the all-files
  blame mode and the "as of HEAD" diff-region view lean on it, so we will
  probably want a blame cache — plausibly keyed by file modified timestamp
  (mtime) so it invalidates when the file changes. Key and invalidation details
  TBD.
- **Server draft schema.** When drafts graduate from client storage to the
  server: keying (project + branch + revision), and how consumed comments are
  retained or pruned.
- **Relationship to forged-transcript-handoff.** A submitted review is a
  narrower, reviewer-authored cousin of that experiment — worth deciding whether
  they share the seeding path.

## Staged plan

1. **One-off line comment → new session.** Add click-a-diff-line → comment on the
   git-status/diff viewer; one comment + its context composes a new session.
   Client storage. Smallest useful slice; proves the line-anchor + provenance
   payload.
2. **Accumulating review — the vision (client-only accumulator).** Persist
   pending comments in `localStorage` across files/commits/revisions with a
   visible count; "submit review" drains all unconsumed into one session and
   marks them consumed. Client-only is the deliberate v1 for build simplicity.
3. **Fuller multipane viewer + all-files blame + search + mobile.** Wrap the flow
   in the large-screen multipane commit/diff/file viewer with the copy
   affordances, the all-files git-blame browsing mode, rudimentary
   commit-delta/filename search, and the mobile back-swipe + commit-jump path.
4. **Server-side drafts (later enhancement).** Move drafts server-side for
   cross-device durability and authoritative consumed state, once the
   client-only accumulator has proven the flow.
