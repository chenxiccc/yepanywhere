# Settings search

> Settings search is the substring filter over the Settings UI: each
> keystroke refines a result list whose matched rows are the real, operable
> setting controls with highlighted match text plus a jump link to the row's
> spot in its named section; matching covers labels, descriptions, section
> and category names — never configured values unless the adjacent
> default-off "Match values" toggle is enabled.

Topic: settings-search

See also: [settings-ui-placement](settings-ui-placement.md) (where options
live), [vanilla-defaults](vanilla-defaults.md) (default-off bar for the
values toggle), [ui-architecture](ui-architecture.md) (render-boundary
principle this design follows).

## Contract

- **Placement.** One search field above the Settings navigation: top of the
  category rail in two-column layout, top of the category list page on
  narrow screens. The narrow category-detail page has no field; Back reaches
  the searchable list. A visible search field in a settings UI is an
  established cross-platform convention (VS Code, Chrome, macOS/iOS/Android
  system settings), not YA-novel chrome, so the field ships always-on;
  see the values toggle below for the configurable part.
- **Refinement.** Filtering is live per keystroke, client-side only, with
  no network round-trip. Semantics are token-AND substring: the query
  splits on whitespace and every token must appear, case-insensitively, in
  the row's searchable text. Esc or the ✕ affordance clears the query and
  restores the normal view. Selecting any category also clears the query, so
  the destination pane never remains hidden behind stale search results.
- **Credential isolation.** Browser or password-manager autofill must never
  populate the query. The field owns a dedicated search form, separate from
  credential inputs mounted by settings panes, and opts out of autocomplete.
- **Search corpus.** A row matches on its declared plain-text label,
  description, and optional hidden keywords; a section matches on its
  title/description; a category matches on its label/description.
  Configured values are excluded by default (standard practice). Rows may
  declare a display-text `valueText` that participates only under the
  values toggle; free-text and credential/secret-bearing fields never
  declare one, so secrets cannot enter matching by construction.
- **Result anatomy.** Results group under clickable category headings, in
  category order. Each matched row is the real control, operable in place —
  toggling/selecting in the result list is the same act as in the pane —
  with matched substrings marked in the label/description (subtle
  accent-tinted `settings-search-mark`, not browser-default highlight).
  Each row also carries a jump link labeled `{Category} › {Section} ›`
  that leaves search, opens the category pane, scrolls the row into view
  centered, and flashes it briefly (`prefers-reduced-motion` suppresses
  the animation).
- **Section and category matches.** A section-title match surfaces the
  whole section operable (its rows stop filtering individually). A
  category-label match lists the category itself under a "Categories"
  heading; it does not dump the whole pane into results.
- **Empty and a11y.** A query with no matches shows an explicit no-results
  line quoting the query. A visually-hidden live region announces the match
  count. The values toggle appears only while a query is active, adjacent
  to the field.
- **Coverage rule.** Every setting is declared through the shared row layer
  (`SettingsItem`, including its custom-layout form, or `SettingsSection`) and
  is searchable. `HideInSettingsSearch` is only for content that is not a
  setting: previews, status blocks, diagnostics, inventories, and form actions.
  A duplicate access point may opt out only when the same setting has a primary
  searchable row elsewhere. Rows that are conditionally unavailable because a
  capability is absent join the search corpus exactly when they join the
  navigation.

## Values matching: why a toggle, why default-off

Standard settings search (VS Code, Chrome, macOS) matches names and
descriptions, not current values; users expect "font" to find the font
settings, not every setting currently set to a font name. Matching values
is still genuinely useful in the inverse lookup — "which setting did I set
to `Fira Code`?" — so YA exposes it as an adjacent **Match values**
checkbox rather than choosing one behavior:

- Default off, per [vanilla-defaults](vanilla-defaults.md): the believed
  benefit earns an option, not a default. The preference is browser-local
  and persists (`UI_KEYS.settingsSearchMatchValues`).
- Values enter matching only as declared display text (`valueText`,
  typically the already-computed select-option label). Boolean toggles
  don't declare one (matching every "off" is noise), and secret-bearing
  fields must not. Value text is matched, not highlighted — the value
  renders inside the control, which search does not rewrite.

## Architecture (why rows declare their own text)

Per [ui-architecture](ui-architecture.md)'s render-boundary principle, the
searchable corpus is declared where the row renders: `SettingsItem`
(pages/settings/SettingsItem.tsx) renders the canonical `.settings-item`
markup and, inside a search scope, filters itself, highlights, and offers
the jump link. Its custom layout and custom base-class forms preserve panels
whose DOM cannot use the standard info/control columns while retaining the
same search and jump contract. Content intentionally hidden from search on its
own becomes visible when its owning row matches. `SettingsSection` does the
same at section granularity. There is no side index to drift and no
post-render DOM rewriting.

Search results mount the *actual pane components* inside
`SettingsSearchResults`, one scope per category. This is what makes rows
operable in place without state-sync hazards: browser-local settings hooks
(e.g. `useFontSize`) do not sync across simultaneous mounts, so the result
row must *be* the pane's row — a single mount — not a copy. Pane-level
undo/title registrations are no-op'd inside the search mount; Undo remains
a pane-context affordance.

Visibility inside a mounted search pane is a small CSS contract (see the
"Settings search" block in `packages/client/src/styles/index.css`): matched
rows render with `settings-search-match`; a fully-matched section adds
`settings-search-section-match` and reveals everything inside it;
`:has()` collapses groups, sections, and panes left with no match; and
non-row content is either row-owned (`after` prop), wrapped in
`HideInSettingsSearch`, or hidden by default in search mode.

**Bounds.** Entering search mounts every category pane once (the same
read-effects as visiting each pane once, as a burst); the mount persists
while the query is non-empty. Per-keystroke work is one deferred context
update fanned to row-level consumers doing substring checks — pane bodies
are memo-isolated and do not re-render per keystroke. A contained mutation
observer recounts results when an asynchronous pane loads dynamic rows. This
surface is typing-rate, not streaming-rate; no further coalescing is required.

## Known limitations / candidate refinements

- **Explicit confirmation and larger jump targets are pending.** A setting
  that deliberately requires confirmation (for example, provider or remote-
  access connection data) must expose that confirmation inside its search-
  result block: Enter submits the edit, and a visible Save action is reachable
  there. Separately, clicking a result row's non-control background should
  perform the existing jump-to-setting behavior without stealing clicks from
  the live control or interfering with text selection. The destination setting
  remains centered when space permits and always receives the temporary
  outline flash, including when no scroll movement is possible. This pending
  work is tracked by
  [`settings-search-confirmation-and-row-navigation`](../gaps/settings-search-confirmation-and-row-navigation.md).

- Rows using a custom `info` body match on their declared strings but do
  not highlight inside the custom markup.
- The two-column category rail does not filter while searching; the
  results panel is the filtered surface.
- The query is component state, not a URL parameter; leaving Settings
  drops it.
- Plain substring only — no fuzzy/stemming ("fonts" does not find
  "font"). Acceptable at current corpus size; revisit only with evidence.
- Value coverage is sparse by design (declared `valueText` only); widening
  it is per-row opt-in, not a sweep.
