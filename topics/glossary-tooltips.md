# Glossary Tooltips

> Glossary tooltips enrich every Markdown-render-eligible view with subtle,
> copyable definition hints from the file-nearest current `GLOSSARY.md`, using
> an in-memory compiled phrase automaton to keep matching linear in rendered
> text.

Topic: glossary-tooltips

Status: planned; implementation deliberately deferred.

## Product contract

Whenever YA renders Markdown rather than source text, YA annotates glossary
terms in the rendered prose. This is one render-boundary feature, not a file-
preview special case. It covers:

- assistant Markdown and other project-affiliated Markdown documents;
- full and range-based Markdown file previews;
- Read and Write previews;
- Markdown-eligible Edit and diff views, including Source Control; and
- organically Markdown-rendered fixed-font output when it has project context.

A surface that stays in source/raw mode is unchanged. Existing gates that keep
code files and non-Markdown diffs out of structural Markdown rendering remain
authoritative; glossary matching does not make an otherwise ineligible surface
Markdown-renderable.

The presence of an in-scope `GLOSSARY.md` is the content-level opt-in. Projects
without one render exactly as before. YA does not create, modify, or exclude a
glossary or any other project-local file for this feature.

## Which glossary controls a render

For a rendered source file, begin in that file's directory and walk parent
directories up to and including the selected project root. The first regular
file named exactly `GLOSSARY.md` controls the render. The nearest glossary
shadows more distant glossaries; rows are not merged across scopes.

Project-affiliated prose without a source-file path uses the project-root
`GLOSSARY.md`. A multi-file diff resolves the glossary independently for each
file section from that section's target path. A `GLOSSARY.md` never annotates
itself.

Source Control deliberately resolves from the current working tree even when
it displays historical source or a commit diff. Glossary definitions describe
the project's current vocabulary; YA does not recover or compile a historical
glossary from the viewed revision. Renamed or deleted paths likewise walk the
current tree from the displayed target path and fall back toward the current
project root.

Every candidate path is resolved through the existing project-containment
boundary. The walk stops at the selected project root and never follows a
glossary outside it. Public-share rendering may use a glossary only when that
file is part of the share's explicit file capability or captured snapshot; a
share must never disclose an otherwise unshared current glossary.

## Glossary term grammar

The first Markdown table supplies glossary rows. The first column is the term
pattern, the second is the definition, and later columns are references or
other metadata that do not enter the tooltip.

A top-level comma in the term cell separates independent phrase patterns. A
Markdown-escaped comma is literal. Each phrase is interpreted separately:

Here a token is one maximal visible non-whitespace run; hyphens and other
attached punctuation remain literal parts of that token. Whitespace separates
tokens and is normalized when optional tokens are omitted.

- If the phrase contains no bold span, its entire visible text is required.
- If it contains bold spans, every bold span is required, in source order.
- Each non-bold visible token is independently optional in its original
  position: the matcher may consume that complete literal token or omit it.
- Omission joins the surviving neighboring pieces with the normalized
  separator implied by the authored phrase; it does not concatenate words.
- Inline code and Markdown escapes contribute their visible literal text.
  Formatting markup itself never becomes match text.

For example:

```markdown
| term | definition |
| --- | --- |
| per-language **published oracle** | The best published system ... |
| **typed** one-to-one **overlap F1** | An overlap score ... |
```

The first row admits exactly `published oracle` and
`per-language published oracle`. The second admits exactly `typed overlap F1`
and `typed one-to-one overlap F1`. It does **not** admit `typed arbitrary words
overlap F1`: optional non-bold tokens are literal alternatives, never `.*`,
wildcards, edit-distance gaps, or unbounded variation.

With several non-bold tokens, each token independently contributes a
present/absent branch. A phrase with `k` such tokens therefore denotes at most
`2^k` literal surface forms before identical forms are deduplicated. Glossary
entries are expected to use one or two optional tokens, producing at most two
or four forms per phrase in the ordinary case. This modest compile-time
expansion is bounded; it is not paid again at every source character.

The canonical label for a match is the complete comma-separated alternative
that produced it, stripped of Markdown emphasis but retaining its optional
qualifiers. The tooltip text is that canonical label followed by the row's
definition flattened to plain text. Reference columns are excluded.

## Match semantics

Matching is case-insensitive over normalized Unicode text. Runs of Markdown
whitespace normalize to one separator for matching while retaining source
offsets for annotation. Punctuation is literal: punctuation and spacing inside
a declared phrase are consumed by that phrase and do not break it.

A candidate begins and ends at an ordinary text boundary—document edge or a
Unicode whitespace/punctuation boundary—so a glossary term does not match as a
substring of a larger word. Those anchors apply only to the phrase edges.
Internal punctuation and whitespace remain part of the literal match, allowing
a declared multi-token phrase to span them in one pass.

Matching follows contiguous visible prose and may cross ordinary inline
formatting boundaries. Links, inline and fenced code, raw HTML, generated
KaTeX, controls, and content that already owns a tooltip are exclusion
boundaries. YA never nests a glossary interaction inside an existing link or
tooltip.

Overlapping matches use one deterministic precedence rule:

1. the match consuming the most visible source text;
2. then the match with the most required bold text;
3. then the earlier glossary-table row; and
4. then the earlier comma-separated alternative in that row.

Copying or selecting rendered prose still yields only the original visible
document text. Glossary metadata must not enter ordinary rich or plain-text
copy output, browser search text, Markdown source mapping, or line-target
alignment.

## Presentation and interaction

An annotated term has a restrained link-like tint at normal font weight. It
has no underline and introduces no box, icon, or layout shift. Hover, active,
and keyboard-focus states may strengthen the tint enough to make the
interaction legible without turning the document into a field of conventional
navigation links.

Pointer hover uses the ordinary tooltip appearance preference:

- Native mode keeps a browser-owned `title` hint.
- Themed mode uses YA's shared tooltip layer, delay, placement, warmth, and
  single-surface ownership.

Primary activation—tap or click—reveals the same tooltip text and copies that
exact text to the clipboard. Touch activation therefore has an explicit YA
surface even when the browser cannot reveal a native title reliably. The
activation surface must not navigate. Keyboard focus reveals the definition;
Enter or Space performs the same reveal-and-copy action. A non-collapsed text
selection wins over activation so selecting prose does not unexpectedly write
to the clipboard.

The term interaction is semantic and keyboard-operable, not a click handler
inferred from arbitrary generated DOM. Tooltip text remains selectable in
Themed mode under the existing tooltip contract. Clipboard failure may leave
the definition visible but must not report a successful copy.

## Compiled matcher contract

Runtime matching uses one compiled multi-pattern phrase automaton per glossary
content version. The intended implementation explicitly expands the small set
of finite literal surface forms, deduplicates them, and indexes them in one
Aho–Corasick-style trie with failure links. It is not a row-by-row regex pass
and does not retry every glossary phrase at every character.

Compilation proceeds conceptually as follows:

1. Parse each comma-separated phrase into required bold spans and independently
   optional non-bold tokens.
2. Expand the present/absent choices into finite literal surface forms. No form
   contains a wildcard or consumes undeclared intervening text.
3. Deduplicate the forms and insert them into one trie, attaching overlap-
   precedence metadata to terminal nodes.
4. Compile failure links so one forward scan recognizes a form beginning at
   any eligible boundary without restarting a phrase loop at each character.
5. Serialize the trie transitions, failure links, terminal metadata, and
   source-version identity.

The hot scan performs amortized constant transition work per normalized code
point plus bounded terminal work: `O(rendered characters + selected matches)`,
with no factor for glossary rows or maximum phrase length after compilation.
Sparse trie transitions keep the serialized artifact small.

Finite expansion can still grow exponentially for adversarial optional-token
counts. Compilation therefore has explicit limits for glossary bytes, rows,
phrase length, optional tokens, expanded forms, alternatives, and trie states.
Exceeding a limit disables glossary annotation for that glossary version with
one bounded diagnostic; ordinary Markdown rendering continues unchanged. It
must never fall back to a per-character regex or phrase loop.

## In-memory resolution and compiled cache

The server owns the canonical file-nearest resolver and holds parsed glossaries
and compiled automata in process memory. V1 has no persistent cache format,
database table, app-data cache file, project-local cache, or restart-recovery
obligation. Glossaries are expected to remain below 1,000 entries, so parsing
and compilation after a server start are bounded ordinary work.

Nearest-file discovery reuses `ProjectPathIndex.findExisting` from
`packages/server/src/projects/projectPathIndex.ts`. Its lazy directory listings
and directory-mtime validation already maintain current presence and absence
for project-relative paths; the glossary resolver should submit the candidate
ancestor paths and select the nearest returned `GLOSSARY.md`, not add another
project-tree watcher or directory cache. See
[project-path-links](project-path-links.md) for that index's contract.

Directory mtime identifies which glossary path exists, but editing an existing
glossary need not change its parent directory. The compiled cache therefore
maps the selected canonical glossary path to its own file identity, parsed
rows, and automaton. An unchanged file identity reuses that structure across
files, sessions, and Source Control views for the life of the server process.
A changed file rebuilds it; a changed directory listing re-runs nearest-file
selection. Successful and failed bounded compilations are cached by the same
identity so a bad glossary cannot cause repeated work on every render.

All glossary-specific cache state may disappear on server restart. If later
measurement shows cold parsing or compilation to be material, a persistent
cache below YA app data may be proposed then; it is neither required nor
preferred for v1 and must never write inside the selected project or its Git
metadata.

Client-only Markdown renderers consume the same serializable compiled artifact
rather than implementing another parser or matcher. The implementation must
complete the optional-feature client/server compatibility review before
choosing its route, response field, and capability name. An older server's
missing capability means the client makes no unsupported matcher request and
renders ordinary Markdown without glossary annotations.

## Render-boundary implementation plan

Implementation remains deferred, but the intended sequence is:

1. **Grammar and phrase-automaton compiler.** Add a browser-free shared
   glossary parser, finite surface-form expansion, serialized trie format,
   matcher, and adversarial budget tests.
2. **Nearest-glossary resolver and in-memory cache.** Reuse
   `ProjectPathIndex.findExisting` for contained ancestor lookup, then add
   file-identity invalidation, current-working-tree Source Control semantics,
   process-memory bounds, and bounded diagnostics.
3. **Compatibility review.** Inspect the required stable-server corpus and
   approve an optional permanent capability plus exact absent-capability
   fallback before adding the client delivery contract.
4. **Shared Markdown annotation boundary.** Feed the matcher into the common
   server Markdown token pipeline and every client-only Markdown renderer.
   Annotation happens on parsed tokens or renderer output before insertion,
   never through a document-wide DOM search after rendering.
5. **Term interaction and style.** Add one semantic term primitive and extend
   the shared tooltip coordinator for activation reveal/copy, Native/Themed
   ownership, keyboard behavior, selection precedence, and clipboard failure.
6. **Surface parity.** Wire assistant prose, FileViewer, Read/Write, fixed-font
   Markdown, Edit/diff, Source Control, standalone local documents, and bounded
   public-share contexts; raw/source modes remain untouched.
7. **Performance and visual acceptance.** Benchmark cold compilation, warm
   process-memory reuse, and linear scans; then capture and inspect desktop and
   phone renders with ordinary, hovered, focused, and tapped terms.

The shared compiler, resolver, and renderer annotation are the owning
invariants. Individual viewers must not grow bespoke glossary regexes, ancestor
walks, or click handlers.

## Verification plan

Grammar and matcher tests cover:

- no-bold phrases, one and several bold spans, edge and intervening optional
  tokens, comma alternatives, and escaped commas;
- independently present/absent optional tokens and rejection of arbitrary
  gaps;
- case, Unicode, whitespace, punctuation, phrase-edge boundaries, and matches
  spanning ordinary inline formatting;
- overlap precedence and stable source offsets after normalization;
- state/byte/row limits, file-identity invalidation, failed-compilation
  caching, and process-memory bounds; and
- a long nonmatching document proving scan work is independent of glossary row
  count and maximum phrase length after compilation.

Resolution tests cover same-directory, nested shadowing, root fallback, no
merge, self-exclusion, containment and symlink escape, current-working-tree
Source Control behavior, deletion/rename, public-share scoping, content-change
invalidation, warm in-process reuse, cold rebuild after server restart, and no
glossary-cache writes to the project or YA app data.

Renderer and interaction tests cover every Markdown-eligible surface, the
source/raw exclusion, existing links/code/KaTeX/tooltips, original-text copy,
selection precedence, Native/Themed exclusive ownership, mouse hover, touch
reveal, exact clipboard text, keyboard reveal/copy, and clipboard failure.

Final browser captures at 1920×1080 and 375×812 confirm a slight
non-underlined tint without layout shift, readable tooltips in both light and
dark themes, and a touch reveal that does not obscure the triggering term or
leave stale tooltip state.

## Acceptance boundary

The feature is complete when every Markdown-render-eligible YA view uses the
same file-nearest current glossary semantics, compiled artifact, match
precedence, visual treatment, and reveal/copy interaction; warm scans are
linear in rendered text; projects without a controlling glossary and surfaces
in source/raw mode remain observably unchanged.
