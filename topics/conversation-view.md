# Conversation View

> Conversation view is an opt-in transcript projection that keeps user prompts,
> agent-authored text, images, and important failures visible while replacing
> routine tool activity with one compact, expandable elapsed/activity summary
> per agent turn.

Topic: conversation-view

Status: **landed** (2026-07-28).

See also:
[collapse-expand-mode.md](collapse-expand-mode.md) for richer action-outline
grouping rather than wholesale conversation condensation;
[session-ui-customization.md](session-ui-customization.md) for the configurable
toolbar surface; [ui-architecture.md](ui-architecture.md) for the render-item
boundary; [session-media-handles.md](session-media-handles.md) for transcript
media ownership.

## Motivation

YA's full transcript is valuable while an agent works, but reads, searches,
edits, commands, and tool results can make it hard to scan back to the actual
exchange—especially on a phone where scrollbar bookmarks are not practical.
The compact view must still show that work happened and allow one-step recovery
of the exact rows. It is a different view of the same loaded transcript, not a
provider-history rewrite and not deletion.

## Observable contract

- The feature is **off by default**. Its two-bubble button is itself a
  default-hidden Session Toolbar control. Once shown, the button switches
  between the full activity transcript and Conversation view.
- The mode is browser/device-local, persists across sessions and tabs, and is
  included in browser-settings backup. The toolbar-presence choice for this
  control is also client-only: it is not sent as a
  `clientDefaults.sessionToolbarPresence` key to servers that may not recognize
  it.
- Conversation view retains user prompts, session setup, transcript display
  objects, agent-authored text, ordinary system notices, warnings, and errors.
  Tool calls with media remain visible, using their existing media renderer, so
  images stay associated with the agent turn's text.
- Routine tool calls (pending, complete, or aborted), Thinking rows, task
  notifications, and subagent-activity notices condense. Tool errors and
  incomplete calls retain their ordinary rows because the user may need the
  failure detail.
- Each assistant turn with condensed activity ends in one summary button. A
  completed summary reads like `4m elapsed · 17 activities hidden`; the live
  edge reads like `Working 4m · 17 activities`. If source timestamps are
  unavailable, the label keeps the activity count without inventing a time.
- Clicking the summary restores every condensed row in its original transcript
  position. The summary remains at the turn end as the one-click collapse
  control. Manual expansion remains sticky while that session view stays
  mounted.
- Switching the whole mode or expanding one turn preserves bottom-follow when
  already at the live edge; otherwise it restores the visible render-row anchor
  (with height-delta fallback) so the reader does not jump to an unrelated
  passage.
- Search follows the currently projected transcript. Condensed tool/thinking
  text does not produce hidden matches; expanding its turn makes those rows
  searchable again.

## Time and count semantics

The duration is an **elapsed activity span**, never CPU time, focused-work time,
or billing time. For a completed assistant turn it spans the earliest to latest
observed source-message timestamps in that turn. While the latest assistant turn
is active, its end is the current client clock.

The count is the number of activities hidden by this view. A tool parent counts
its ordered semantic display actions when the provider projection supplies
them; otherwise each hidden render item counts once. Media and retained
failure rows are not included because they are still visible.

## Deferred: meaningful documentation prose

There is a plausible middle ground between hiding every edit and showing raw
code-edit machinery: a documentation edit authored by the agent can itself be
conversation-relevant prose. This is deliberately **not v1 behavior** because a
filename or tool name alone cannot reliably distinguish prose from generated,
mechanical, or code-like changes.

A future implementation should prefer a compact `document name + bounded added
prose` card, with the whole edit block available only on expansion. It may emit
that card only when all of these are true:

- the target is classified as documentation by a conservative path/type policy
  (for example Markdown or another explicitly registered prose format), not
  merely because the filename happens to contain `doc`;
- the provider/compiler supplies trustworthy structured edit hunks and target
  paths, rather than YA scraping terminal output or rendered DOM;
- added lines are predominantly prose and fit a bounded excerpt after removing
  diff markers; code fences, generated sections, bulk formatting, vendored
  text, and large mechanical rewrites fail closed;
- the excerpt is agent-authored addition, not surrounding source context,
  deleted text, command output, or user-authored content.

When a doc edit is meaningful but no safe excerpt can be derived, the compact
form may say `Document edited: <name>`. Open questions are the excerpt bound,
whether multiple doc hunks form one card, and how to mark mixed prose/code
documents. Images remain ordinary visible media associated with the turn; this
extension must not absorb them into edit summaries.

## Implementation boundary

`projectConversationView` runs after the stable provider transcript projection
and before turn grouping, timeline rows, search, and React rendering. It adds a
synthetic `conversation_activity` render item rather than hiding DOM nodes.
This keeps ordering, media retention, search scope, progressive rendering, and
scroll anchoring attached to the same render-item model as the full transcript.
