# Quarto-aware Markdown documents lose publication semantics in the file viewer

YA's rendered-document path recognizes `.qmd` and renders standalone Quarto
include directives as inert file-viewer links under the contract in
[`topics/quarto-markdown.md`](../topics/quarto-markdown.md). `safe-markdown.ts`
still renders a deliberately small Markdown-It vocabulary, so a
Quarto/Pandoc manuscript shown in `FileViewer` loses or exposes as source such
high-value document semantics as YAML front matter, figure identifiers and
captions, subfigures/layout divs, cross-references, `fig-alt`, and footnotes.
The existing footnote limitation is also recorded in
[`topics/rich-text-rendering.md` § Known gaps / future work](../topics/rich-text-rendering.md#known-gaps--future-work).

The primary feature should be an explicit **Render with Quarto** action in the
document viewer. YA still shows its safe direct preview immediately; the user
can request the higher-fidelity publication render without making every file
open wait for an external tool. Quarto rendering should become routine or
automatic only after representative cold/warm measurements show that it is
fast enough for normal viewing and the execution boundary below is satisfied.
The result stays bound to the source revision, and the action reports a missing
Quarto executable or unsupported server capability without breaking the direct
preview.

Targeted inert support remains complementary and can be layered into or over
the existing Markdown-It renderer wherever a construct has an unambiguous,
high-utility document meaning. This path improves the immediate preview and the
fallback on servers without Quarto; it is not a reason to approximate every
Quarto feature inside Markdown-It:

- [x] recognize `.qmd` consistently across read/write augments, local-file
  routes, diffs, file actions, syntax highlighting, and the shared client
  extension test;
- [x] render a valid standalone `{{< include path >}}` directive as an inert
  contained file-viewer link without reading or expanding the target;
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

Add a feature scan that reports which constructs YA rendered directly and which
remain source-only, so the button can explain what higher-fidelity rendering
would add. Clicking the button is consent to request a document render, not
consent to run arbitrary project code with YA/server authority. The render path
must not run executable cells, extensions, Lua filters, includes, project
`pre-render` scripts, or other project-authored code outside an explicitly
designed containment boundary. Any renderer process needs resource limits;
generated output and caches belong under YA's data directory by default, never
beside the manuscript. Sanitized fragments may stay in YA's document origin,
while executable output follows
[`active-content-security`](../topics/active-content-security.md).

The eventual path should remain progressive: show the safe direct preview
immediately, bind every result to the file's source revision, cancel or ignore
a stale delayed render, and retain source/raw access. Hosted clients need an
explicit server capability and the same direct-preview fallback; absence of a
local Quarto executable must not make ordinary `.qmd` reading fail.

Close this gap only after fixtures exercise an ordinary `.md` and a `.qmd`
containing front matter, a main figure with subfigures, native textual panels,
captions versus alt text, cross-references, and footnotes in the shared file
viewer at desktop and phone widths. Exercise the explicit Quarto action,
missing-tool/capability fallback, stale-result cancellation, and source/raw
escape hatch. Also prove that the direct path executes nothing, neither path
makes project/Git writes, and the direct path preserves complete document text
without tooltip interaction; every hover enhancement must also work by
keyboard and have a non-hover document form. Record cold and warm Quarto
latency before considering any automatic rendering policy.

Found 2026-08-12 while defining Quarto-native figure and caption guidance for
research papers, handouts, and blogs in `~/agents`.
