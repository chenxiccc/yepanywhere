# Quarto Markdown documents

> Quarto Markdown (`.qmd`) files use YA's safe Markdown preview while
> supported Quarto-only constructs remain inert, navigable document structure.

Topic: quarto-markdown

## Current contract

`.qmd` is a Markdown-like file throughout the file viewer, local-file viewer,
Read and Write tool previews, Source Control diffs, syntax highlighting, path
detection, and public-share source discovery. It receives the same source and
preview controls as `.md`; opening or rendering it does not invoke the Quarto
CLI.

YA recognizes Quarto's built-in `include` shortcode only when it is the sole
content of its Markdown block, matching Quarto's documented requirement that
the directive appear by itself on a line and be surrounded by blank lines. A
recognized `{{< include path >}}` renders as an **Include** link to `path` in
the existing file-viewer link system. Relative targets resolve from the
document directory. In an authenticated project view, a leading slash resolves
from the project root, matching Quarto's project-root path convention.

The direct renderer never expands or reads the included file. Directives in
ordinary `.md` files, prose, lists, and fenced code remain literal source.
Remote destinations, malformed directives, and parent-traversing relative
paths also remain literal. Link targets still pass through the existing
project membership and local-file access policies.

Quarto's include behavior and block placement rules are documented in
[Quarto Includes](https://quarto.org/docs/authoring/includes.html).

## Design decisions

- **Represent includes as links** (vs. expanding their contents): this makes
  document structure navigable without introducing recursive source reads,
  ambiguous source-copy alignment, or Quarto execution semantics.
- **Gate Quarto syntax on the `.qmd` caller context** (vs. interpreting every
  Markdown paragraph as Quarto): ordinary Markdown keeps its existing literal
  shortcode behavior, and source-aligned copying preserves the authored
  directive.
- **Keep direct preview inert** (vs. silently invoking Quarto): explicit,
  contained higher-fidelity rendering remains future work because Quarto
  projects can include executable cells, extensions, filters, and hooks.

## Incomplete publication semantics

Front matter, cross-references, footnotes, figure layout, captions, and the
explicit **Render with Quarto** action remain tracked in
[`gaps/quarto-aware-document-view.md`](../gaps/quarto-aware-document-view.md).
That gap also owns the execution boundary, source-revision binding, capability
fallback, performance measurements, and project-storage constraints for a
future Quarto process.
