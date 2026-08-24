# Project Code Names

> Project code names are unique, editable short project labels used in browser
> titles and sidebar rows so session titles retain more visible space.

Topic: project-code-names

Status: **proposal.** This records the requested product contract; it is not
implemented yet.

## User-visible contract

- Every project has one code name. The generated default is the first three
  letters of the project name, and the value is editable from Projects.
- Code names are unique across the projects visible to one YA server. A
  generated value is persisted rather than changing when project ordering or
  the set of visible sessions changes.
- A session browser title uses `[code]: title`, for example
  `[yep]: Improve tab titles`.
- Sidebar project labels use the same code name so more of each session title
  remains visible. The full project name remains available in the Projects
  surface and wherever disambiguating detail is needed.
- When the tab-title activity preference is enabled, activity alternates only
  the `[code]` segment between ordinary and bold-looking forms. It does not add
  the current `(●)` / `(○)` frame, so activity costs no additional title
  characters. Existing needs-attention counts remain a separate leading
  indicator.

## Default allocation

Start with the first three letters. If that code is already taken, hold the
first two positions and advance the final selected letter toward the end of the
full project name until a unique code is found. If those candidates are all
taken, advance the previous selected position and try the later final letters
again.

Equivalently, for `abcdef`, try the three-letter subsequences with the first
letter fixed in this order:

```text
abc, abd, abe, abf,
acd, ace, acf,
ade, adf,
aef
```

If every such candidate is taken, retain the first two letters and replace the
last position with `2`, then `3`, then `4`, and so on until the code is unique:

```text
ab2, ab3, ab4, ...
```

This ordering is deterministic. Given the same project name and reserved code
names, every client and server must choose the same result, although allocation
should have one server-side owner rather than be independently recomputed by
clients.

## Editing and conflicts

An explicit user edit wins the requested code. If another project already owns
that code, the conflicting project is automatically assigned the first
available result from the same default-allocation recipe. Regeneration checks
the complete reserved set, so resolving one conflict cannot create another.

The edit and any displaced-project reassignment are one atomic server-owned
metadata change. Every connected client should observe the same pair of
updates, and a reconnect should retain them.

## Activity rendering constraint

`document.title` is plain text and cannot apply CSS font weight to only the
code-name substring. A literal bold/unbold cycle therefore needs a text-level
representation, most plausibly alternating ordinary letters with their Unicode
mathematical-bold equivalents. Before implementation, verify that the chosen
mapping:

- remains readable in supported browser tab fonts;
- has acceptable width and does not undermine the space-saving goal;
- preserves digits and unsupported characters predictably; and
- does not produce misleading screen-reader pronunciation.

If no text representation meets those constraints, standard browser title APIs
cannot provide the requested partial-bold effect; that limitation should be
resolved explicitly rather than silently restoring a character-consuming
spinner.

## Ownership and compatibility

The code name is project metadata in YA app data, not state written into the
selected project directory and not a browser-local preference. The server owns
uniqueness and conflict resolution; clients render the assigned value.

Adding the metadata field to project responses and edits is a client/server
contract change. Implementation must follow the stable-release compatibility
review and capability-gating rules before a hosted client depends on it. An
older server without the field should continue rendering the full project name
and existing tab-title format.

## Open details

The proposal does not yet settle:

- case folding and whether punctuation or whitespace is skipped;
- projects whose names contain fewer than three usable letters;
- the allowed length and character set for manual edits;
- the numeric fallback after the available one-character suffixes are
  exhausted; or
- whether renaming a project regenerates an untouched automatic code name or
  leaves every assigned code stable until explicitly edited.

## Related contracts

- [`docs/tactical/003-session-activity-tab-title.md`](../docs/tactical/003-session-activity-tab-title.md)
  records the current opt-in activity preference and single title-composition
  path. This proposal changes its visible activity frames, not its activity
  source or timer ownership.
- [`project-settings-overrides.md`](project-settings-overrides.md) establishes
  app-data ownership for project-scoped settings, although code names are
  project identity metadata rather than session-default overrides.
- [`sidebar-session-ordering.md`](sidebar-session-ordering.md) owns sidebar row
  stability; introducing shorter labels must not re-sort active sessions.
