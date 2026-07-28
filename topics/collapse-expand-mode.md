# Collapse/expand mode (action-outline density)

> Brainstorm (not a contract yet): a YA mode that default-collapses more of the
> action stream into compact outline groups, with expand revealing detail —
> including live subagent progress inline. Includes a proposed unification of
> `/btw` asides and agent-initiated subagents as one child-work-stream component.

Status: **exploratory / brainstorming** (user, 2026-06-22). Records the idea,
the current partial implementation, and the design constraints so a later
implementation pass starts from compiled understanding rather than re-discovery.
Nothing here is a committed default.

See also: [`provider-read-edit-disciplines.md`](provider-read-edit-disciplines.md)
(the canonical tool-name mapping this grouping relies on),
[`thinking-expand-latest-only.md`](thinking-expand-latest-only.md) (an existing
expand-default policy with the same shape),
[`provider-agnostic-btw-asides.md`](provider-agnostic-btw-asides.md) (the
`/btw` aside — proposed to **unify** with agent subagent streams; see § below),
[`ui-architecture.md`](ui-architecture.md) (render-boundary principle),
[`task-list-rendering.md`](task-list-rendering.md) (subagent/`Task` rendering),
[`conversation-view.md`](conversation-view.md) (the landed, coarser
conversation-only projection with one expandable activity summary per turn).

Topic: collapse-expand-mode

## What exists today

Adjacent read-style actions are already grouped into an **"Explored"** block —
the presentation the user saw in recent Claude/Codex. It is real but **partial**:

- `packages/client/src/components/blocks/ExploredToolGroup.tsx`:
  `buildAssistantRenderSegments` walks an assistant message's render items and
  folds either a **run of ≥2** consecutive exploration tool parents or one
  parent with **≥2 ordered semantic exploration actions** into one
  `{kind:"explored"}` segment. A single one-action parent renders normally.
  Runs break when two parents are more than
  `EXPLORATION_GROUP_MAX_GAP_MS` (5 min) apart.
- **Exploration kinds = read / search / list only** (`getExplorationKind`),
  canonicalized cross-provider through `toolRegistry.get(name).tool` plus
  lowercase aliases — so it rides on the same canonical vocabulary as the
  read/edit-disciplines mapping (`Read`/`Grep`/`Glob` and provider lowercase
  forms `read`/`grep`/`ls`/`list_dir`/…).
- The group renders a per-entry one-line summary (interactive summary when the
  renderer offers one, else a path/pattern fallback) with a status glyph.

### Why "not done consistently" is accurate

- **Default is expanded.** `ExploredToolGroup` opens with `expanded = true`, so
  today's behavior is *grouping*, not *collapsing*. There is no mode that
  default-collapses.
- **Only exploration semantics fold.** Edits, web fetches, and **subagent
  (`Task`) calls** are never grouped. A Bash/Exec parent folds only when its
  fail-closed semantic analysis contains reads/searches/lists exclusively.
- **Runs or a compound exploration parent.** A lone one-action read between two
  edits stays full; grouping needs either ≥2 adjacent parents or ≥2 ordered
  semantic entries under one parent.
- **Per-group local state.** Expand/collapse is component-local `useState`, not a
  session- or app-level density preference, so it cannot express "collapse more,
  everywhere, by default."

## The envisioned mode

A YA **collapse/expand mode** (opt-in setting/toggle) that raises outline density
by default-collapsing more of the action stream, then lets the user expand for
detail. Open design questions, not decisions:

This remains distinct from the landed **Conversation view**. Conversation view
condenses all routine activity in a turn behind one elapsed/count marker;
collapse/expand mode would preserve named action groups such as Explored,
Edited, and Ran as a legible outline.

- **Scope of collapse.** Beyond read/search/list: fold edit runs, `Bash` runs,
  and tool clusters into labeled outline rows. Likely a small set of named
  groups ("Explored", "Edited", "Ran") rather than one undifferentiated blob, so
  the collapsed line still says *what kind* of work happened.
- **Default expansion = collapsed in this mode.** Flip `ExploredToolGroup`'s
  open-state default *under this mode only*; keep the current expanded default
  when the mode is off (see *Constraints*).
- **Density as a real preference.** Lift expand/collapse default from per-group
  `useState` to a session/app density setting so "collapse more by default" is
  one switch, with per-group manual override still sticky within a view.
- **Latest-active stays legible.** Mirror `thinking-expand-latest-only`: the most
  recent / in-flight group may auto-expand so the live edge is never hidden
  behind a collapsed row.

## Subagent progress — and unifying with `/btw`

A specifically-wanted expand target: a collapsed **subagent (`Task`)** action,
when expanded, reveals that subagent's **live progress inline in the outline** —
its nested action stream / status — rather than only a terminal summary.

**The collapsed row is itself two-part** (user, 2026-06-22): a stable first part
showing the subagent's **original scope/request**, and a second part showing its
**recent activity** — so even collapsed, the row says both *what was asked* and
*what it is doing now*. The second part **updates often** as the subagent works,
which makes the collapsed (not just expanded) subagent row a live, high-rate
surface — see *Constraints*: coalesce the recent-activity updates before React,
and keep the stable first part from re-rendering on every activity tick.

**Two expand affordances** (spec/vision, user 2026-06-22) on that collapsed row:

- **Full expand** — the usual outline affordance (the chevron) opens the whole
  subagent subtree, same as any group.
- **Expand the active path** — clicking in the **left margin of the second
  (recent-activity) part** expands *recent/ancestors up to the latest update*:
  the chain from the subagent down to its most recent activity, not the entire
  subtree. This is the active-leaf-path view (same shape as the durable
  active-leaf path in [`pi-provider.md`](pi-provider.md)), letting the user drill
  to "what is it doing right now and how did it get there" without unfolding
  every sibling branch.

### Unify `/btw` asides with agent subagents (proposed)

An earlier draft of this section called the subagent outline view *distinct* from
`/btw` and said the two must not share an implementation — the worry being that
pane-routing state would leak into a trivial outline expand. The user proposes the
opposite, and it reconciles cleanly (user, 2026-06-22): treat **`/btw` asides and
agent-initiated subagents (the `Task` tool, usually parallelizing research) as one
"child work stream" abstraction with a single implementation.** Both are a side
stream with the same two-part shape — a stable scope/request and a
frequently-updating recent-activity part — so what differs is not the data model
but two explicit axes:

- **Interactive vs observe-only.** A `/btw` aside is interactive: its
  **minicomposer lives in the second (recent-activity) part**, so the user can
  inject into the side stream. An agent subagent is observe-only by default (no
  composer); the same slot can host one later if YA lets the user steer a
  subagent.
- **Placement.** *Inline outline node* (pure outline expand, in place) vs *pinned
  above the main composer* (the existing collapsed minisplit,
  `packages/client/src/lib/btwAsideRouting.ts`) vs a full split pane. **Pinning
  above the composer becomes a toggle for both**, not a btw-only mode.

This *resolves* the earlier concern rather than contradicting it: pane-routing
becomes **one placement axis of the shared component**, chosen per stream, not a
separate mechanism. A subagent can render as a pure outline node *and* be
promotable to the pinned minisplit; a `/btw` aside can collapse into the outline.
Several parallel research subagents are then just multiple child streams the one
component lays out (an inline list, and/or a few pinned).

Open questions: where in-flight `Task` events come from (live stream vs polled
summary); how deep nesting goes (a subagent spawning a subagent); how a collapsed
parent signals child activity (count, spinner, unread mark); whether unifying
drags btw's provider-agnostic side-session machinery onto every subagent row
(cost); and the minimal shared stream interface (scope, activity feed, optional
composer, placement).

## Constraints any implementation must honor

- **Preserve the non-buggy default (opt-in).** Per CLAUDE.local.md *UI Changes
  Preserve Non-Buggy Defaults*: the current expanded-grouping behavior is fine,
  so the new collapse-more mode ships **off by default** behind a toggle/setting;
  flipping the global default later is a separate, explicit one-line decision,
  not bundled with the feature.
- **Provider-agnostic via canonical names.** Grouping must key on the canonical
  tool vocabulary (and lowercase provider aliases) exactly as
  `getExplorationKind` already does, so every backend folds identically — same
  contract as [`provider-read-edit-disciplines.md`](provider-read-edit-disciplines.md).
- **Render-boundary principle.** Decide grouping at the render-item/segment
  builder (`buildAssistantRenderSegments`), not by post-hoc DOM surgery on
  already-rendered rows ([`ui-architecture.md`](ui-architecture.md)).
- **No high-rate render churn.** A live subagent expand is a streaming surface;
  per CLAUDE.local.md *Client Performance Path Coverage*, coalesce nested-progress
  updates before they reach React. Collapsed rows should be cheap — a collapsed
  group must not subscribe every child to high-rate updates it isn't showing.

## Relation to "normalizations as their own topic"

The user noted the explore-grouping is "related to normalizations, which can be
their own topic." For now the cross-provider tool-name/field normalization lives
in [`provider-read-edit-disciplines.md`](provider-read-edit-disciplines.md) (§ *How
YA maps named blocks to one presentation*), because disciplines and their mapping
are hard to explain apart. If that mapping section grows its own weight
(more providers, field-shape rules, output re-shaping), graduate it to a
dedicated `tool-normalization.md` and have both this topic and the disciplines
topic point at it. Not warranted yet.
