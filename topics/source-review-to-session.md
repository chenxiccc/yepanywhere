# Source Review → New Session

> A read-only source-control/repo viewer whose primary job is directing
> agents, not managing git. In a large-screen multipane layout you navigate
> the working-tree diff and recent commit(s) and — Gerrit/GitHub style —
> **click a diff line to open a comment window**. You do not select an exact
> span; nearby context is implied. Comments accrue as drafts across files and
> diff lines while the tree keeps changing under them; "submit review" drains
> **every not-yet-consumed comment at once** into one review session — a new
> one, or a recent review session as a follow-up turn — and archives them as
> consumed. Drafts are **server-owned**: every git-state operation here passes
> through the server anyway, and a long review spans devices, so a review
> continues seamlessly across browsers. A mobile back-swipe version (with a
> small commit-jump selector) is usable too. No git write actions from this
> surface; agents keep doing the commits/merges.

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
  - [floating-new-session-composer](floating-new-session-composer.md) — prior
    art for composing a first turn from a non-session page; the submit
    endpoint owns the actual launch (see the implementation sketch).

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
  existing session manually, or opt for a fresh one. "Recent" is a default,
  not a gate; each consumed batch records which session it went to.
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
- **Where drafts live: server-owned, in the project's `.yep/` dir.**
  Relocation, blame, and submit composition all need server git access, so
  the server owns the drafts and is the single authority for
  pending/archived state — a review started on the desktop continues on the
  phone with the same pending set and archive. Storage is a git-ignored
  project-local `.yep/review-comments.json` per the agreed `.yep/`
  YA-managed-state home ([interactives](interactives.md)): the project path
  is the keying (two repos' drafts can never mix), the drafts follow the
  checkout they annotate, and the file sits exactly where the seeded
  prompt's review file must live, so submit composes largely by reference.
  The client holds only UI state (the open comment window's in-progress text
  may keep a localStorage backup, like message drafts).

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
  diff); the diff pane renders **unified or side-by-side** per the
  diff-view-mode decision below, side-by-side reading as a 4-column layout.
  From a commit's diff you can switch to an **"as of HEAD" content view
  centered on the diff region, with a blame gutter** — bridging the
  commit-review mode into the all-files/blame provenance.
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
- **Server-owned drafts from v1** (vs. a client-only `localStorage`
  accumulator graduating to the server later): every git-state operation the
  feature needs already passes through the server, so putting drafts there is
  the simpler build, not the harder one — and device-switching during a long
  review makes server authority the right semantics anyway. One owner for
  consumed/archived state; no schema graduation step.
- **Drafts stored in project-local `.yep/`** (vs. a data-dir store keyed by a
  project mapping): follows the established `.yep/` YA-managed-state
  convention, gets per-project keying from the path itself, keeps drafts
  with the worktree they annotate, and co-locates them with the review file
  the seeded prompt references.
- **Diff view mode: one three-valued preference, `auto | unified |
  side-by-side`, defaulting to `auto`** (vs. a bare side-by-side boolean, or
  side-by-side always): graehl mildly prefers side-by-side, but the default
  is whatever the width allows — `auto` picks side-by-side exactly when the
  diff pane measures wide enough for two readable code columns, else
  unified. "Wide enough" is a content measurement of the pane against a
  minimum readable code column, not a viewport breakpoint
  ([responsive-layout-gaps](responsive-layout-gaps.md)). The manual toggle
  lives **in the diff pane itself** (beside the existing full-context
  toggle) so the mode is switchable on the spot, and it persists as a
  **device-local browser preference** — screen sizes vary per device, so
  this is typically set once per device and does not travel between them.
  One mode value, not coupled booleans.
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
- **Review-file/draft-file split.** Whether the seeded prompt references
  `.yep/review-comments.json` directly or a per-submit snapshot beside it,
  and how a follow-up turn's update composes with the archive. How archived
  comments are pruned.
- **Relationship to forged-transcript-handoff.** A submitted review is a
  narrower, reviewer-authored cousin of that experiment — worth deciding whether
  they share the seeding path.

## Staged plan

1. **One-off line comment → new session.** Add click-a-diff-line → comment on
   the git-status/diff viewer — which is the working-tree diff, so this slice
   already exercises the `uncommitted` anchor class. Built as the single-entry
   accumulator drained immediately (per the fast-path definition above), it
   proves the line-anchor + provenance payload with no parallel code path.
2. **Accumulating review — the vision.** Persist pending comments in the
   server-owned `.yep/review-comments.json` across files and commits with a
   visible count; "submit review" runs the preview (stale comments
   pre-selected discard), drains the survivors into the target session
   (recent review session by default, override to any or new), and archives
   them consumed.
3. **Fuller multipane viewer + all-files blame + search + mobile.** Wrap the flow
   in the large-screen multipane commit/diff/file viewer with the copy
   affordances, the all-files git-blame browsing mode, rudimentary
   commit-delta/filename search, the unified/side-by-side diff view mode
   (orderable independently — it touches only the existing diff viewer),
   and the mobile back-swipe + commit-jump path.

## Implementation sketch (implementer guide)

Verified against the tree at a682f7c3 (2026-07-26); file references are real,
nothing below is built. This is the concrete shape for stages 1–2.

### What exists to build on

- Route `/git-status` → `packages/client/src/pages/GitStatusPage.tsx`
  (~1450 lines — already large; every new pane below is a new file composed
  into it, never inline growth).
- `pages/GitStatusDiffPreview.tsx` fetches
  `api.getGitDiff(projectId, { path, staged, status, fullContext? })` →
  `GitDiffResult` and renders `diffResult.diffHtml` — server-generated Shiki
  HTML — via `dangerouslySetInnerHTML` (`HighlightedDiff`), with a per-line
  `DiffLines` fallback when highlighting was skipped.
- The diff HTML's lines already carry classes
  `line line-deleted|line-inserted|line-context|line-hunk`, added at
  generation time by `addDiffLineClasses`
  (`packages/server/src/augments/edit-augments.ts`).
- `GitDiffResult.structuredPatch: PatchHunk[]`
  (`packages/shared/src/types.ts:736`): `oldStart`/`newStart` plus
  `' '|'-'|'+'`-prefixed `lines` — per-side line numbers are computable by
  walking hunks; no DOM needed.
- Server JSON-persistence idiom: `PushService`
  (`packages/server/src/push/PushService.ts`) — typed state, load once,
  debounced save — is the template for the drafts service.
- Session plumbing: two-phase `api.createSession(projectId, opts)` +
  `POST /sessions/{id}/messages`; server-side, the supervisor and
  project-queue already create sessions and deliver first turns.

### Consequential decisions

1. **Anchors derive from `structuredPatch`, never from the DOM.** A click
   identifies (hunk index, line index); a pure shared helper computes side,
   old/new line numbers, and the context snippet from `PatchHunk` data. The
   Shiki HTML stays presentation-only, so anchor logic is testable without a
   browser and cannot drift from what is displayed.
2. **Line clicks: server-emitted indices + one delegated listener; no DOM
   patching.** Extend `addDiffLineClasses` to also emit
   `data-diff-line="<flat line index>"` at generation time; the diff pane
   attaches a single click handler on the `.highlighted-diff` container that
   walks to the nearest `[data-diff-line]`. Per-line React components would
   abandon server highlighting; attaching handlers by post-processing the
   injected HTML would patch generated DOM (the
   [ui-architecture](ui-architecture.md) rule). Give the `DiffLines` fallback
   the same attribute so one handler serves both renderers. The
   comment-anchor tint ([selection-comment-ui](selection-comment-ui.md)) is a
   class toggled on nodes addressed by that same server-emitted attribute —
   idempotent decoration of stably-addressed nodes, not restructuring.
3. **Wire types in `packages/shared` with a defensive parser.**
   `shared/src/review-comments.ts`: `ReviewCommentAnchor` (path; anchoring
   revision `sha | { uncommitted: true, savedAt }`; side; old/new line;
   snippet), `ReviewComment` (id, anchor, text, `pending | archived`, batch +
   target-session link). Parse persisted data defensively (the
   `parseClaudeAdditionalModelSelections` idiom): `.yep/review-comments.json`
   outlives bundle versions and is user-visible on disk, so the shape is a
   contract from day 1.
4. **One review service owns the file.**
   `packages/server/src/review/ReviewCommentService.ts` (PushService shape)
   reads/writes `{projectPath}/.yep/review-comments.json`: comment CRUD,
   pending→archived transitions, batch records. Routes in a new
   `packages/server/src/routes/review-comments.ts` — `routes/git-status.ts`
   is 1200 lines and must not absorb this feature.
5. **Submit is one server endpoint; preview is its dry run.**
   `POST /api/projects/:projectId/review/preview` relocates every pending
   anchor (exact line match against HEAD/worktree, then fuzzy snippet match,
   git plumbing) and returns per-comment `{ relocated | gone }` for the
   discard-default preview.
   `POST …/review/submit { include, target: "new" | sessionId }` re-runs
   relocation, composes the short prompt referencing the review file, creates
   the session (supervisor) or posts the follow-up turn, archives the batch
   with its target, and returns the session id for the client to navigate to.
   The client stays dumb: render preview, confirm, navigate. Relocation and
   turn composition are pure modules (`review/relocateAnchors.ts`,
   `review/composeReviewTurn.ts`) with the endpoint as thin glue.
6. **Stage 1 cuts scope by count, not by shape.** The one-off fast path is
   the same service, file, and submit endpoint with a single pending comment
   and no preview UI — relocation is trivially exact because the anchor is
   seconds old. No client-side storage variant exists at any stage.
7. **Side-by-side is a client arrangement of once-highlighted lines.** Today
   `diffHtml` is one Shiki block; side-by-side must not become a second
   server render that can drift from the first. When the diff pane grows the
   view mode, the render unit becomes per-line highlighted fragments (the
   line elements `addDiffLineClasses` already produces), and the client
   arranges them — unified as a stack, side-by-side as a two-column pairing
   whose `-`/`+` run alignment is computed from `structuredPatch` (pure
   data, same source as anchors). The `data-diff-line` click/tint contract
   addresses lines, not the container, so it survives both layouts
   unchanged; a left-column click is a `-`-side anchor, a right-column click
   `+`-side. The `auto` default measures the pane per the diff-view-mode
   decision; the in-pane toggle persists device-locally. This piece touches
   only the existing diff viewer, so it can land independently of stages
   1–2.

### Tests that pin the contract

- Anchor-from-patch helper: hunk walking yields correct old/new line numbers
  at boundaries (first/last line of a hunk, context vs `-`/`+` lines).
- Parser: round-trip of persisted comments; garbage and truncated files
  reject to empty rather than throwing.
- Relocation, against a fixture repo: unchanged line → relocated; moved line
  → fuzzy-relocated; deleted line → gone (SHA cited); an `uncommitted`
  anchor whose change has since been committed acquires that commit's SHA.
- Service: per-project isolation (two projects never mix), pending→archived
  lifecycle, a batch records its target session, archive survives service
  restart.
- Compose: SHA appears only for gone/minus-side comments; from-X-to-Y
  framing carries both sides; comments group by file; the
  read-current-state instruction is present in every prompt.
- Client (RTL): clicking a `.line-inserted` node in rendered `diffHtml`
  opens the comment window with the correct anchor; a commented line shows
  the tint; the preview lists gone-context comments first, pre-selected
  discard (mocked preview API).
- View mode (with stage 3): `auto` resolves unified when the pane measures
  below two readable columns and side-by-side above; a manual pick wins over
  `auto` and survives reload; in side-by-side, a left-column click anchors
  `-`-side and a right-column click `+`-side.

### Subtask phases (each lands green)

Stages 1–2 decompose into subtask-sized phases, each verifiable by its own
tests before the next begins. Every phase before P6 is user-invisible, so no
half-built UI ever ships; P6 is the first visible milestone (= stage 1).

- **P1 — anchor model (shared).** Types + defensive parser +
  anchor-from-patch helper. Verified by unit tests alone (hunk-boundary line
  numbers, round-trip, garbage rejection). Land paired with P2 or P3 so the
  contract module does not sit consumerless.
- **P2 — line addressing (server).** `addDiffLineClasses` emits
  `data-diff-line` matching the flat `structuredPatch` index. Verified by
  augment unit tests asserting index↔line agreement; invisible in the UI,
  safe alone.
- **P3 — drafts service + CRUD routes (server).** `ReviewCommentService`
  over `.yep/review-comments.json` plus `routes/review-comments.ts` CRUD.
  Verified by route tests (per-project isolation, lifecycle, restart
  survival) and by curl against a dev-profile instance.
- **P4 — compose + relocation (server, pure).** `composeReviewTurn` and
  `relocateAnchors` as pure modules with fixture-repo tests
  (SHA-only-when-gone, moved/gone/committed-uncommitted cases). No routes
  yet.
- **P5 — preview + submit endpoints.** Thin glue over P3 + P4 plus the
  supervisor launch. Route tests with a stubbed supervisor; one real
  single-comment submit against a dev-profile instance closes the stage-1
  backend.
- **P6 — click → comment window → submit-now (client).** Delegated
  listener, `CommentWindow`, tint, submit-now button. RTL tests; the
  stage-1 user-visible milestone.
- **P7 — pending tray + submit preview + target picker (client).** RTL
  tests for discard-default ordering and the recent-review-session default;
  the stage-2 milestone.
- **P8 — diff view mode.** Independent of all of the above (decision 7);
  orderable any time.

Dependencies: P1 → {P2, P3, P4}; P5 needs P3 + P4; P6 needs P2 + P5; P7
needs P5 (and P6's window for editing). P2/P3/P4 parallelize after P1.
