# Clean Working Tree Landing

Status: implemented and verified 2026-08-11.

Topic: source-control

## Origin

The clean Source Control landing currently opens the newest commit, adds a
**Working tree clean** badge to every selected commit, and leaves the pinned
Working tree revision styled as a yellow **Uncommitted** warning even when it
contains zero changed files. At constrained desktop pane widths, the redundant
clean badge can also overflow the commit identity and overlap its actions.

Two useful workflows are in tension: one user wants Changes to answer only
whether current work exists, while another wants a clean repository to expose
the newest commit immediately. The landing choice is a user preference; commit
identity and working-tree state should remain separate regardless of that
choice.

## Product contract

- An ordinary Changes navigation opens Working tree by default at desktop and
  phone widths. A clean repository shows the existing spacious clean-state
  confirmation; a dirty repository shows its changed files.
- A browser-local Source Control preference named **When the working tree is
  clean** offers **Working tree status** (default) and **Latest commit**.
- The preference applies only to an ordinary clean Changes landing. An explicit
  history request, legacy commits URL, commit deep link, or working-tree file
  link remains authoritative.
- A selected commit identifies only that commit. Repository cleanliness remains
  in the Source Control identity header and is not repeated in commit detail.
- The pinned Working tree history row presents its actual state. Clean uses
  calm success/neutral treatment and says **Clean · No uncommitted changes**;
  dirty retains warning treatment and says **Uncommitted · N changed files**.
- The preference participates in browser-settings backup and the Settings
  pane's existing undo behavior.

## Compatibility scope

This is client-only presentation and browser-local persistence inside the
existing `git-source-review` surface. It adds no server route, response field,
event, capability, request, or compatibility-floor change. Explicit URL state
continues to override the landing preference.

## Implementation plan

### 1 — define the clean Changes landing

Update the Source Control topic and tests so Working tree status is the normal
default and latest-commit selection is an explicit browser preference.

### 2 — add the browser-local Source Control preference

Add one typed local-storage value, include it in portable browser-settings
backup, and expose it in Settings → Source Control with localized copy and undo.

### 3 — restore status-first clean navigation

Consult the preference only when a clean Changes URL has no explicit history,
commit, or working-tree file target. Keep deliberate history and deep-link
behavior unchanged.

### 4 — make the Working tree revision honest

Remove the clean badge and its overflow-prone commit-detail styling. Render the
pinned Working tree row from real clean/dirty state, with warning color reserved
for actual uncommitted work.

### 5 — verify responsive Source Control

Run focused Source Control, setting, preference, and backup tests; format the
exact edited files; run CSS ownership/containment, lint, typecheck, client
console, and relevant workspace checks; then inspect fresh-server screenshots
at 1920×1080 and 375×812.

## Acceptance

- A clean repository with no stored preference opens the clean Working tree
  confirmation and does not request a commit detail.
- Choosing Latest commit restores the current clean auto-selection at desktop
  and phone widths.
- Commit deep links and explicit history continue to open commit history.
- The clean pinned row has no yellow warning treatment or **Uncommitted** copy.
- A dirty pinned row retains warning treatment and its changed-file count.
- No commit detail contains **Working tree clean** or overlaps its controls.
- The setting is searchable, undoable, portable through browser-settings
  backup, and responsive at phone width.

## Non-goals

- Remembering the last selected revision as an implicit landing policy.
- Changing dirty-repository landing behavior.
- Changing Git or review server APIs.
- Adding more Source Control landing modes or per-project overrides.

## Implementation results

- The ordinary clean Changes route now opens the quiet Working tree
  confirmation. Settings → Source Control can opt the browser back into Latest
  commit, and browser-settings backup carries that choice.
- The pinned Working tree revision now distinguishes clean from dirty state.
  Commit detail no longer repeats repository cleanliness.
- Unit coverage passed with the full client suite: 392 files and 3,466 tests.
  The persistent Playwright flow in
  `packages/client/e2e/source-control-clean-landing.spec.ts` passed against a
  fresh isolated server and Git fixture.
- Fresh 1920×1080 and 375×812 captures verified the clean landing, history row,
  and responsive setting. No stale-server banner or clean-status overlap was
  present.
- Lint, typecheck, format, CSS architecture, i18n advisory, and console-budget
  checks passed. The bounded Working tree state styles moved into a component
  module and lowered the `renderers.css` ceiling by 14 lines; broader component
  extraction remains deferred because the ownership inventory reports a
  coupled legacy slice.
