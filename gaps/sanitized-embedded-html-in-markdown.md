# Markdown previews do not render sanitized embedded HTML

CommonMark permits raw inline HTML and HTML blocks, but YA configures
Markdown-It with `html: false` in
`packages/server/src/augments/safe-markdown.ts`. Authored elements are therefore
shown as source rather than rendered. This prevents a Markdown document from
using ordinary inert HTML where pipe-table syntax is insufficient, such as a
grouped table header with `colspan` or `rowspan`.

The downstream `sanitize-html` boundary already permits table structure and
other renderer-generated elements, but its `<th>` and `<td>` policy permits
only `align`. Enabling Markdown-It's HTML option alone would therefore parse
the table while stripping its cell spans.

Enable sanitized embedded HTML in the shared Markdown renderer with the two
corresponding configuration changes in `safe-markdown.ts`:

1. Set Markdown-It's `html` option to `true` so CommonMark inline HTML and HTML
   blocks reach the rendered fragment.
2. Add `colspan` and `rowspan` to the `sanitize-html` allowed attributes for
   `<th>` and `<td>` so joined table cells survive sanitization.

The HTML must continue through the existing sanitizer before reaching the
client. This is sanitized rich-text rendering under
`topics/active-content-security.md`, not unsanitized pass-through or general
project HTML preview. The shared renderer means the behavior should stay
consistent across assistant Markdown, tool-result Markdown, and Markdown file
previews.

Regression coverage should prove that a grouped-header comparison table keeps
its `colspan`, that `rowspan` survives on both header and data cells, and that
scripts, event attributes, unsafe URLs, and other disallowed markup remain
blocked by `sanitize-html`. Include parity between initial render and persisted
reload. Rendered desktop and phone captures should prove that joined cells
remain readable without widening the viewer.

This was captured rather than implemented because the user requested a gap
entry rather than the renderer change itself.

Found 2026-08-26 while evaluating a comparison table that required joined
header cells.
