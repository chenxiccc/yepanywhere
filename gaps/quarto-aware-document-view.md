# Quarto-aware Markdown documents lose publication semantics in the file viewer

YA's rendered-document path currently recognizes `.md`/`.markdown` (with
slightly different extension sets at different callers), but not `.qmd`.
`safe-markdown.ts` renders a deliberately small Markdown-It vocabulary, so a
Quarto/Pandoc manuscript shown in `FileViewer` loses or exposes as source such
high-value document semantics as YAML front matter, figure identifiers and
captions, subfigures/layout divs, cross-references, `fig-alt`, and footnotes.
The existing footnote limitation is also recorded in
[`topics/rich-text-rendering.md` § Known gaps / future work](../topics/rich-text-rendering.md#known-gaps--future-work).

The preferred first tranche is direct, inert support in YA's ordinary
sanitized Markdown viewer. It should apply by default where the syntax has an
unambiguous high-utility document meaning, without requiring a "Quarto mode":

- recognize `.qmd` consistently across read/write augments, local-file routes,
  diffs, file actions, and the shared client extension test;
- treat front matter as document metadata rather than body punctuation;
- preserve separate title, visible caption/subcaption, image alt description,
  identifier, and cross-reference roles;
- render footnotes and make their references focusable; HTML may add the
  existing YA tooltip interaction, but the visible/end-note form remains
  complete without hover;
- support the smallest useful fenced-div/figure-panel vocabulary for native
  text, tables, images, and mixed qualitative examples; and
- resolve extensionless multiformat figures conservatively from the source
  directory without writing into the project.

Do not approximate every Quarto feature inside Markdown-It. Add a feature scan
that reports which constructs YA rendered directly and which remain source-
only. A later enhancement may replace the immediate direct preview with a
delayed actual Quarto render when unsupported publication constructs are
present, but only after its execution boundary is designed. Opening a project
document must not run executable cells, extensions, Lua filters, includes,
project `pre-render` scripts, or other project-authored code with YA/server
authority. Any renderer process needs explicit containment and resource
limits; generated output and caches belong under YA's data directory by
default, never beside the manuscript. Sanitized fragments may stay in YA's
document origin, while executable output follows
[`active-content-security`](../topics/active-content-security.md).

The eventual path should remain progressive: show the safe direct preview
immediately, bind every result to the file's source revision, cancel or ignore
a stale delayed render, and retain source/raw access. Hosted clients need an
explicit server capability and the same direct-preview fallback; absence of a
local Quarto executable must not make ordinary `.qmd` reading fail.

Close this gap only after fixtures exercise an ordinary `.md` and a `.qmd`
containing front matter, a main figure with subfigures, native textual panels,
captions versus alt text, cross-references, and footnotes in the shared file
viewer at desktop and phone widths. Also prove that the direct path executes
nothing, makes no project/Git writes, and preserves complete document text
without tooltip interaction; every hover enhancement must also work by
keyboard and have a non-hover document form.

Found 2026-08-12 while defining Quarto-native figure and caption guidance for
research papers, handouts, and blogs in `~/agents`.
