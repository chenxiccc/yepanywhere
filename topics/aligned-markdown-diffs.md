# Aligned Markdown Diffs

> A source-positioned Markdown projection that preserves diff lanes, line
> identity, and scroll context while rendering changed Markdown semantically.

Topic: `aligned-markdown-diffs`

Status: Proposal. Source Control still replaces a Markdown diff with a
whole-document preview; none of the aligned projection described here is
implemented yet.

## Problem and invariant

Source Control currently returns `GitDiffResult.markdownHtml` by rendering the
entire new file in `buildGitDiffResultFromBytes`. `GitDiffContent` then replaces
`UnifiedDiff` or `SideBySideDiff` with one `MarkdownPreview`. The replacement has
no `data-diff-line` identities and no old-side representation. The toggle also
retains only a numeric scroll position, so the same offset lands on unrelated
content after the DOM changes height. <!-- verified: SHA b9c534fb -->

That behavior violates the representation invariant: **switching between raw
and rendered diff views must preserve the same Git projection and logical
source location**. Preview is a view of the diff, not a request to discard the
diff and show the current document.

Session Edit panels already demonstrate the useful baseline. Markdown-like
targets pass their structured patch through the diff-aware rich-text path in
`FixedFontMathToggle`: each ordinary source line remains a rendered row with
its `+`, `-`, or context lane, while headings, lists, blockquotes, links, tables,
and math receive bounded semantic rendering. It is intentionally approximate,
but it preserves more of the diff than Source Control's whole-file preview.

## Observable contract

- Preview renders the selected working-tree, commit, or comparison diff. It
  never silently changes that projection to the complete new document.
- Removed and added content remain distinguishable. Context shared by both
  sides is represented once in unified mode and on both sides in side-by-side
  mode.
- Every rendered unit carries its source side, inclusive source-line span, and
  the corresponding flat `structuredPatch` line identities. Review anchors and
  hunk navigation continue to derive from `structuredPatch`, never from
  reparsing rendered HTML.
- Switching Diff/Preview, unified/side-by-side, or diff/full-context preserves
  the top visible logical line and its pixel offset from the scroll viewport.
  Raw `scrollTop` is not a cross-representation identity.
- The renderer is resumable. It accepts source one line at a time, may stop at
  a completed block boundary, and can continue without reparsing completed
  blocks. An incomplete block stays source-like until enough input closes it.
- Rendering uses the existing safe Markdown semantics: project-relative links,
  KaTeX policy, syntax highlighting, sanitization, and escaped raw HTML do not
  fork into a Source Control dialect.
- Large-file and long-line preview guards continue to apply before expensive
  parsing. Cancellation or a changed projection fingerprint discards the old
  cursor rather than allowing stale spans into a refreshed working-tree diff.
- Phone and narrow layouts may stay unified, but they retain the same source
  identities and Diff/Preview anchor behavior.

## Projection model

The durable unit is a source span, not an arbitrary HTML fragment:

```ts
interface MarkdownDiffSpan {
  side: "old" | "new" | "context";
  sourceStartLine: number;
  sourceEndLine: number;
  flatDiffLines: number[];
  kind:
    | "line"
    | "paragraph"
    | "heading"
    | "list"
    | "blockquote"
    | "table"
    | "code"
    | "math";
  html: string;
}
```

The exact public shape may differ, but these identities are load-bearing.
`flatDiffLines` lets the existing comment and hunk machinery address the same
patch rows in either representation. Source lines let scroll restoration and
full-context expansion address the document rather than whichever DOM happens
to be mounted.

The incremental renderer keeps an in-process cursor containing at least the
next source line, absolute character offset, pending block start, open
fence/list/table state, and reference-definition context. The cursor need not
become a wire or persisted format unless server pagination later needs to move
it across requests. Its behavioral contract should nevertheless be exercised
as `feed(line) -> completed spans` plus `flush()` so a future windowed renderer
does not require a rewrite.

Reference-style links are a deliberate two-pass exception. The complete file
is already available for a Git diff, so a cheap definition scan can precede
incremental block rendering. That preserves references to definitions later in
the file without making every completed block depend on a whole-document HTML
render. `renderMarkdownFilePreview` already uses this pattern when rendering
source-aligned slices.

## Recommended rendering path

### 1. Reuse the session diff renderer

First factor the diff-aware rich projection out of `FixedFontMathToggle` into a
shared pure renderer that consumes `structuredPatch` rows directly. Preserve a
one-row-per-source-line wrapper and add the same `data-diff-line` identity used
by `UnifiedDiff` and `SideBySideDiff`. This immediately fixes the main defect:
Preview remains scoped to the displayed hunks, removed content remains visible,
and the existing side-by-side pairing can arrange rendered fragments.

This stage is intentionally no more semantically ambitious than session Edit
diffs. It should reuse their tested rules instead of creating a second Markdown
diff grammar in Source Control.

### 2. Add source-positioned block completion

`BlockDetector` already supports line/chunk feeding and emits completed blocks
with absolute `startOffset` and `endOffset`; `renderMarkdownToHtml` already uses
those blocks before applying the established safe renderer. Extend that
boundary to retain line spans and feed old and new documents independently.

The block layer improves multi-line constructs without weakening row identity:

1. Pre-scan reference definitions.
2. Feed one normalized source line at a time to each side's detector.
3. Convert emitted offsets to inclusive source-line spans.
4. Intersect spans with the patch's changed and context rows.
5. Render only completed spans. Keep an open span source-like until it closes.
6. Emit checkpoint state after each completed top-level block so work can be
   cancelled or resumed at bounded points.

The union of patch hunk boundaries, unchanged shared lines, and old/new
top-level block boundaries forms the set of alignment points. A block that
crosses a change may fall back to the line renderer inside that alignment band;
semantic polish must not erase a changed-line identity.

### 3. Align pixels by rows or bounded bands

`buildSideBySideRows` remains the authority for pairing removal/addition runs.
For line-renderable constructs, each pair is one CSS grid row whose height is
the maximum of its old and new cells. For a construct that must remain a single
semantic block, place the two source spans in one bounded alignment band and
resume exact row pairing at the next shared boundary.

This gives exact alignment for the normal case and honest coarse alignment for
the hard case. Stretching unrelated individual lines merely to make the bottoms
of two large paragraphs coincide is not useful alignment.

## Tables, HTML, and other edge cases

GFM tables need one source row per visual row. Keep header context and column
alignment as table-block state, but render each changed body row as its own
aligned row with negligible vertical padding. A CSS grid with table roles, or
individually valid one-row tables with synchronized column widths, is safer
than injecting unattached `<tr>` fragments. The separator line may be a
zero-height source anchor owned by the header row.

Do not rely on browser auto-tag-closing as a contract. YA's safe renderer
already escapes raw Markdown HTML, so user-written `<table>`, `<details>`, and
unbalanced closing tags remain literal text. Every generated fragment should
therefore be valid, closed HTML before sanitization. The awkward close-tag case
is limited to YA-generated semantic tables/lists, which the projection owns.

Other bounded fallbacks:

- A fenced code block keeps per-code-line anchors; opening and closing fences
  may be compact marker rows but must remain addressable.
- A display-math block renders only when all of its lines belong to one diff
  lane, matching the existing rich-diff contract. Mixed-lane math remains
  literal.
- Lazy list continuations, setext headings, and table headers may require one
  line of lookahead. The cursor buffers that line; “one line at a time” does not
  mean prematurely committing an ambiguous line.
- A multi-line paragraph may render line fragments joined as one paragraph.
  Soft-break markers retain source identity without forcing a visible `<br>`.
  Until that composition exists, the existing line renderer is the correct
  fallback.

## Scroll and navigation

Before a representation change, capture the first visible source marker:

```ts
interface MarkdownDiffScrollAnchor {
  side: "old" | "new" | "context";
  sourceLine: number;
  flatDiffLine?: number;
  viewportOffsetPx: number;
}
```

After the replacement commits, a layout effect finds the same marker and
adjusts the scroll root so its viewport offset is unchanged. If that exact side
or line is absent, use the nearest surviving patch line in this order: same
hunk, same source side, shared context, then the next hunk boundary. This same
anchor can replace raw scroll retention when changing full-context or
side-by-side modes.

Hunk next/previous continues to operate while Preview is active. A rendered
block intersecting a hunk exposes the hunk marker on its first source row; it
does not disappear merely because the code-font projection is unmounted.

## Package options

No standard package is a drop-in solution because YA must preserve its current
Marked extensions, project-file links, KaTeX rules, Shiki output, and sanitizer.
The useful candidates are boundary or migration options:

- [markdown-it](https://markdown-it.github.io/markdown-it/) exposes
  `Token.map` as `[line_begin, line_end]`, which is directly useful for block
  alignment. Adopting it as renderer would still require parity work for YA's
  existing Markdown extensions and safety behavior.
- [unified/mdast](https://unifiedjs.com/learn/guide/syntax-trees-typescript/)
  assigns parsed nodes 1-indexed line/column positions; `remark-gfm` adds GFM
  tables. It offers the richest transform surface but is a larger parser and
  rendering-pipeline migration.
- [commonmark.js](https://www.npmjs.com/package/commonmark) can emit block-level
  `data-sourcepos`, but CommonMark alone does not cover YA's GFM table needs.
- [Lezer Markdown](https://www.npmjs.com/package/@lezer/markdown) produces
  compact position trees and can reuse fragments for incremental parsing. It
  intentionally does not render HTML and relaxes some reference-link
  validation, so it is best considered as a sidecar boundary index rather than
  a semantic authority.

The first implementation should add no parser dependency. Reuse the existing
line renderer, then extend `BlockDetector` source spans. Prototype one of the
packages only if detector parity tests show that maintaining GFM block
boundaries locally is becoming a parser project.

## Verification matrix

Contract tests should cover:

- a changed heading, ordinary paragraph line, blockquote, and thematic rule;
- insertion, deletion, replacement, and lazy continuation inside lists;
- table header/separator changes, body-row replacement, and an unmatched row;
- fenced code with a changed interior line and with an incomplete fence;
- display math wholly in one lane and deliberately split across lanes;
- a reference link whose definition occurs later in the file;
- raw and unbalanced HTML remaining escaped;
- unified and side-by-side diff identities matching `structuredPatch` exactly;
- opening a review comment from the first rendered frame;
- hunk navigation while Preview is active;
- Diff/Preview and full-context toggles preserving a far-down source anchor;
- cancellation/resumption at every completed block boundary producing the same
  spans as an uninterrupted render;
- a working-tree refresh invalidating an older projection and its cursor;
- desktop and phone captures for long wrapping paragraphs and tables.

The strongest pure invariant is: for every active projection, each addressable
flat patch line appears exactly once per applicable lane, source-line mappings
are monotonic, and rendering never combines added and removed source into one
semantic block.

## Implementation sequence

1. Extract and reuse the session diff-aware renderer with explicit patch-line
   identities.
2. Replace whole-document Markdown Preview in `GitDiffContent`; add logical
   scroll-anchor restoration and keep hunk/comment behavior mounted.
3. Add incremental source spans to `BlockDetector` and the Markdown projection
   result, preserving the current safe renderer.
4. Add aligned tables and other multi-line constructs one kind at a time,
   retaining the line fallback for unsupported or incomplete blocks.
5. Measure large-document cancellation/resumption before considering a new
   parser dependency or a new client/server wire shape.
