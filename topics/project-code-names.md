# Project Code Names

> Project code names are unique, editable short project labels used in browser
> titles and sidebar rows so session titles retain more visible space.

Topic: project-code-names

Status: **implemented.**

## User-visible contract

- A capable server assigns every project one code name. The generated value
  starts with the first three letters of the project name, but remains latent
  until the browser opts into **Short Project Code Names** in Appearance.
- **Short Project Code Names** is browser-local and defaults off. While off,
  browser titles and sidebar rows use full project names with their released
  ellipsis behavior, and Projects hides the code-name editor. This is the
  vanilla presentation for fresh browser profiles.
- Enabling **Short Project Code Names** displays the code in smaller text
  directly below the full name on Projects. Clicking it opens an inline editor,
  leaving the field commits, and the adjacent × cancels.
- Code names are unique across the projects visible to one YA server. A
  generated value remains stable across project ordering and visible-session
  changes, but is regenerated if another project's name introduces a generated
  prefix collision.
- With short code names enabled, a session browser title uses `code:title` with
  no brackets or post-colon space, for example `yep:Improve tab titles`.
  Sidebar project labels use the same code so more of each session title remains
  visible. The full project name remains available in Projects and wherever
  disambiguating detail is needed.
- **Pulse Project Code for Tab Activity** is a second browser-local Appearance
  preference and defaults off. Ordinary tab-title activity therefore uses the
  same `(●)` / `(○)` frames on code-name and full-name titles. When both short
  code names and the pulse are explicitly enabled, a code-name title alternates
  only its leading code between ordinary and bold-looking forms; titles without
  a code name retain the circle frames. Existing needs-attention counts remain
  a separate leading indicator.

The activity preference remains browser-local, opt-in, and default-off. Code
names themselves remain server-owned project identity even while their client
presentation is disabled.

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
code-name substring. The optional pulse therefore alternates ASCII letters and
digits before the leading colon between ordinary characters and their Unicode
Mathematical Bold equivalents. Underscores, hyphens, and any unsupported
characters remain unchanged. The composer always normalizes the previous frame
before applying the next one, so animation cannot accumulate styled code
points. Omitting a post-colon space offsets the small width increase of the bold
frame and keeps the effect subtle. Without that explicit pulse preference,
every title uses the released `(●)` / `(○)` activity frames.

## Ownership and compatibility

The code name is project metadata in YA app data, not state written into the
selected project directory. The server owns uniqueness and conflict resolution;
the browser-local preferences own whether the client renders the assigned value
and whether activity pulses it.

Capability `project-code-names` (permanent ID 46, version-implied from `0.7.2`)
owns the response field, edit route, and invalidation event. The reviewed older
server corpus is `v0.7.0` and `v0.6.2`; without the capability, a current client
uses full project names, preserves the released title format and activity
frames, hides editing, and sends no code-name request. Enabling the browser
preference against such a server does not weaken that fallback.

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
