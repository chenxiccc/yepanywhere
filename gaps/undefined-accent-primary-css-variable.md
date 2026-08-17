# Undefined `--accent-primary` silently drops focus rings and accents

`var(--accent-primary)` is referenced 26 times across client CSS with no
fallback, but the variable is never defined in any `:root`/theme block. Three
further uses spell it `var(--accent-primary, #3b82f6)`, which is the only form
that renders — strong evidence the intended value is that blue.

A bare reference to an undefined custom property makes the *whole* declaration
invalid at computed-value time, so these are not merely off-color: a
`outline: 2px solid var(--accent-primary)` focus ring renders as no ring at
all, and `background: var(--accent-primary)` renders as transparent. Diagnosed
2026-08-17 while adding the sidebar subagent activity rail, whose accented
level computed to `rgba(0, 0, 0, 0)` in both light and dark themes.

Affected files: `styles/index.css` (17), `SessionListItem.module.css`,
`ProviderChildSessionControl.module.css`, `BangCommandsPage.module.css`,
`ViewerCountIndicator.module.css`, `BangCommandDisplayObject.module.css`.

Fix: define `--accent-primary` once per theme alongside `--app-yep-green` and
the other palette entries in `styles/index.css`, pick the value deliberately
(the `#3b82f6` the fallbacks assume, or the brand green), then drop the
now-redundant inline fallbacks. Verify focus rings actually appear afterward
rather than trusting the diff.

Closed when the variable is defined and no bare `var(--accent-primary)`
reference resolves to nothing.
