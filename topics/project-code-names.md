# Project Code Names

> Project code names are unique, editable short project labels used in browser
> titles and sidebar rows so session titles retain more visible space.

Topic: project-code-names

Status: **implemented.**

## User-visible contract

- Every project has one code name. The generated default is the first three
  letters of the project name. Projects displays it in smaller text directly
  below the full name; clicking it opens an inline editor, leaving the field
  commits, and the adjacent × cancels.
- Code names are unique across the projects visible to one YA server. A
  generated value remains stable across project ordering and visible-session
  changes, but is regenerated if another project's name introduces a generated
  prefix collision.
- A session browser title uses `code:title` with no brackets or post-colon
  space, for example `yep:Improve tab titles`.
- Sidebar project labels use the same code name so more of each session title
  remains visible. The full project name remains available in the Projects
  surface and wherever disambiguating detail is needed.
- When the tab-title activity preference is enabled, activity alternates only
  the leading code segment between ordinary and bold-looking forms. It does not
  add the current `(●)` / `(○)` frame, so activity costs no additional title
  characters. Existing needs-attention counts remain a separate leading
  indicator.

The activity preference remains browser-local, opt-in, and default-off. Code
names themselves are server-owned project identity and are always available
from a capable server.

## Default allocation

Start with the first three letters. A generated candidate collides when another
code already owns it case-insensitively or when it is a prefix of another
project's normalized full name; the project being named is excluded from the
full-name check.

After the three-letter default collides, first try the first four contiguous
characters. That candidate is still unavailable when it equals or prefixes a
different project's full name. Then hold the first two positions and advance
the final selected letter toward the end of the name. If those candidates are
all taken, advance the previous selected position and try the later final
letters again.

Equivalently, for `abcdef`, try the three-letter subsequences with the first
letter fixed in this order:

```text
abc, abcd,
abd, abe, abf,
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
clients. When several projects need allocation together, project names and then
URL-safe project IDs use JavaScript code-unit order; host locale never changes
the winner.

## Editing and conflicts

Every syntactically valid explicit user edit wins. Manual values are not subject
to the generated prefix/full-name collision rule. If another project already
owns the exact code, that project is automatically assigned the first available
result from the same default-allocation recipe. Regeneration checks the complete
reserved set, so resolving one conflict cannot create another.

The edit and any displaced-project reassignment are one atomic server-owned
metadata change. Every connected client should observe the same pair of
updates, and a reconnect should retain them. Automatic reconciliation has the
same publication rule: after the complete assignment set is durably saved, the
server emits one invalidation naming every project whose code changed. It never
publishes an intermediate collision or an assignment that persistence rejected.

## Character and editing rules

Automatic allocation applies Unicode NFKD normalization, removes combining
marks, retains ASCII letters and digits, and lowercases them. A name with fewer
than three usable characters starts with all available characters; a name with
none starts with `prj`. Numeric fallback remains unbounded (`ab2` … `ab10`) so
allocation cannot exhaust.

Manual edits trim surrounding whitespace, preserve the user's letter case, and
accept 1–12 ASCII letters, digits, underscores, or hyphens; values longer than
the three-character generated default are ordinary. Exact uniqueness is
case-insensitive. Metadata retains whether the current value was manually
assigned so later generated-name reconciliation cannot rewrite it. A project
rename updates the remembered source name used for a possible later conflict
displacement, but never changes the assigned code name by itself.

## Activity rendering

`document.title` is plain text and cannot apply CSS font weight to only the
code-name substring. The enabled activity cycle therefore alternates ASCII
letters and digits before the leading colon between ordinary characters and
their Unicode Mathematical Bold equivalents. Underscores, hyphens, and any
unsupported characters remain unchanged. The composer always normalizes the
previous frame before applying the next one, so animation cannot accumulate
styled code points. Omitting a post-colon space offsets the small width increase
of the bold frame and keeps the effect subtle. A capable title spends no extra
characters on activity; the legacy `(●)` / `(○)` frames remain only as the
older-server fallback.

## Ownership and compatibility

The code name is project metadata in YA app data, not state written into the
selected project directory and not a browser-local preference. The server owns
uniqueness and conflict resolution; clients render the assigned value.

Capability `project-code-names` (permanent ID 46, version-implied from `0.7.2`)
owns the response field, edit route, and invalidation event. The reviewed older
server corpus is `v0.7.0` and `v0.6.2`; without the capability, a current client
uses full project names, preserves the released title format and activity
frames, hides editing, and sends no code-name request.

## Related contracts

- [`docs/tactical/003-session-activity-tab-title.md`](../docs/tactical/003-session-activity-tab-title.md)
  records the current opt-in activity preference and single title-composition
  path. This feature changes its visible activity frames, not its activity
  source or timer ownership.
- [`project-settings-overrides.md`](project-settings-overrides.md) establishes
  app-data ownership for project-scoped settings, although code names are
  project identity metadata rather than session-default overrides.
- [`sidebar-session-ordering.md`](sidebar-session-ordering.md) owns sidebar row
  stability; introducing shorter labels must not re-sort active sessions.
