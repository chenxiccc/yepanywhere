# Glossary Tooltips

> Glossary tooltips enrich every Markdown-render-eligible view with subtle,
> copyable definition hints from one governing current `GLOSSARY.md` and its
> project-contained include graph, using an in-memory compiled phrase
> automaton to keep matching linear in rendered text.

Topic: glossary-tooltips

Status: implementation in progress under
[`docs/tactical/087-glossary-tooltip-implementation.md`](../docs/tactical/087-glossary-tooltip-implementation.md);
the shared grammar, resolver, capability-gated delivery, tab-local cache,
annotation boundary, interaction, and authenticated render surfaces are
implemented. Standalone local documents, explicitly authorized public-share
artifacts, and final performance/visual acceptance remain pending.

## Product contract

When the browser-local **Glossary hints** Appearance preference is enabled and
YA renders Markdown rather than source text, YA annotates glossary terms in the
rendered prose. The preference is default-off under
[vanilla-defaults](vanilla-defaults.md). This is one render-boundary feature,
not a file-preview special case. It covers:

- assistant Markdown and other project-affiliated Markdown documents;
- full and range-based Markdown file previews;
- Read and Write previews;
- Markdown-eligible Edit and diff views, including Source Control; and
- organically Markdown-rendered fixed-font output when it has project context.

A surface that stays in source/raw mode is unchanged. Existing gates that keep
code files and non-Markdown diffs out of structural Markdown rendering remain
authoritative; glossary matching does not make an otherwise ineligible surface
Markdown-renderable.

The presence of an in-scope `GLOSSARY.md` is the content-level prerequisite;
the browser preference is the user-level opt-in. Projects without one and
browsers with the preference disabled render exactly as before. YA does not
create, modify, or exclude a glossary or any other project-local file for this
feature.

## Which glossary controls a render

For a rendered source file, begin in that file's directory and walk parent
directories up to and including the selected project root. The first regular
file named exactly `GLOSSARY.md` is the single governing glossary for that
render. Parent and sibling glossaries do not participate merely because of
their placement; the governing glossary opts into their entries by referring
to them.

Project-affiliated prose without a source-file path uses the project-root
`GLOSSARY.md`. A selected Source Control file resolves from its displayed
target path. A `GLOSSARY.md` never annotates itself.

Any project-local path mentioned in a parsed `GLOSSARY.md` whose basename is
`GLOSSARY.md` is an include edge. Includes are transitive. For each mention,
the resolver checks both the directory containing the referring glossary and
the selected project root as bases. It normalizes each result, rejects paths
outside the project, converts retained candidates back to project-relative
paths for indexed lookup, and includes every distinct existing regular file
whose real path also remains inside the project. The referring file itself is
ignored, canonical paths are included only once, and cycles therefore
terminate without special author syntax. Escaped candidates are discarded; a
mention with no contained resolution is rejected with one bounded diagnostic.
A valid directory-relative `../../GLOSSARY.md` may therefore normalize to the
project root and remain contained even though the project-root-relative
candidate is discarded.

The governing file followed by a depth-first, source-order traversal of its
first-seen includes forms one ordered glossary. Each file contributes the rows
from its first Markdown table in table order. This is an explicit union, not
implicit inheritance from directory placement.

Source Control deliberately resolves from the current working tree even when
it displays historical source or a commit diff. Glossary definitions describe
the project's current vocabulary; YA does not recover or compile a historical
glossary from the viewed revision. Renamed or deleted paths likewise walk the
current tree from the displayed target path and fall back toward the current
project root.

Every governing and included path is resolved through the existing project-
containment boundary. Public-share rendering may use a glossary only when that
file is part of the share's explicit file capability or captured snapshot; a
share must never disclose an otherwise unshared current glossary through an
include.

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

Each non-bold token independently contributes a present/absent branch. V1
allows at most two optional non-bold tokens in each comma-separated phrase,
so one phrase produces at most four literal surface forms before identical
forms are deduplicated. The same cap applies independently to every comma
alternative. This modest compile-time expansion is bounded; it is not paid
again at every source character.

The canonical label for a match is the complete comma-separated alternative
that produced it, stripped of Markdown emphasis but retaining its optional
qualifiers. One concrete surface form maps to one tooltip string. Each
distinct source row that produces that form contributes one paragraph made
from its canonical label and definition flattened to plain text; several
entries, including conflicts within one glossary, are concatenated as
consecutive paragraphs in governing-closure order. When more than one row
contributes, each paragraph identifies its glossary's project-relative
directory. Duplicate expansions from the same row contribute only once.
Reference columns are excluded from tooltip text even when a reference creates
an include edge.

## Match semantics

Matching is case-insensitive over normalized Unicode text. Runs of Markdown
whitespace normalize to one separator for matching while retaining source
offsets for annotation. Punctuation is literal: punctuation and spacing inside
a declared phrase are consumed by that phrase and do not break it.
Hyphen-minus, Unicode hyphen, and non-breaking hyphen are word characters at
phrase edges, so hyphenated and space-separated forms are distinct unless the
term cell declares both as comma-separated alternatives. A Markdown list
marker still precedes an eligible match because its following space is the
boundary.

A candidate begins and ends at an ordinary text boundary—document edge or a
Unicode whitespace/punctuation boundary other than a lexical hyphen—so a
glossary term does not match as a substring of a larger or hyphenated word.
Those anchors apply only to the phrase edges. Internal punctuation and
whitespace remain part of the literal match, allowing a declared multi-token
phrase to span them in one pass.

Matching follows contiguous visible prose and may cross ordinary inline
formatting boundaries. Links, inline and fenced code, raw HTML, generated
KaTeX, controls, and content that already owns a tooltip are exclusion
boundaries. YA never nests a glossary interaction inside an existing link or
tooltip.

Overlapping matches use one deterministic precedence rule:

1. the match consuming the most visible source text;
2. then the match with the most required bold text;
3. then the earlier glossary in governing-closure order;
4. then the earlier glossary-table row; and
5. then the earlier comma-separated alternative in that row.

Entries producing the same concrete surface form share one automaton terminal
and one candidate span, so their definition paragraphs do not compete under
this overlap rule.

Copying or selecting rendered prose still yields only the original visible
document text. Glossary metadata must not enter ordinary rich or plain-text
copy output, browser search text, Markdown source mapping, or line-target
alignment.

## Presentation and interaction

An annotated term has a restrained link-like tint at normal font weight. It
has no underline and introduces no box, icon, or layout shift. The term wrapper
inherits the surrounding font metrics and adds no padding, border width,
letter spacing, minimum size, or inline width. Enabling hints or replacing an
unannotated render after the matcher becomes ready must not change line height,
line breaks, text width, or source-aligned geometry. Hover, active, and
keyboard-focus states may strengthen the tint enough to make the interaction
legible without turning the document into a field of conventional navigation
links.

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

Runtime matching uses one compiled multi-pattern phrase automaton per governing
glossary include-graph version. The intended implementation explicitly expands
the small set of finite literal surface forms, deduplicates them while
retaining every contributing definition paragraph, and indexes them in one
Aho–Corasick-style trie with failure links. It is not a row-by-row regex pass
and does not retry every glossary phrase at every character.

Compilation proceeds conceptually as follows:

1. Parse each comma-separated phrase into required bold spans and independently
   optional non-bold tokens.
2. Expand the present/absent choices into finite literal surface forms. No form
   contains a wildcard or consumes undeclared intervening text.
3. Deduplicate the forms and insert them into one trie, attaching ordered
   definition paragraphs and overlap-precedence metadata to terminal nodes.
4. Compile failure links so one forward scan recognizes a form beginning at
   any eligible boundary without restarting a phrase loop at each character.
5. Serialize the trie transitions, failure links, terminal metadata, and
   source-version identity.

The hot scan performs amortized constant transition work per normalized code
point plus bounded terminal work: `O(rendered characters + selected matches)`,
with no factor for glossary rows or maximum phrase length after compilation.
Sparse trie transitions keep the serialized artifact small.

Compilation has explicit aggregate limits for include depth, included files,
glossary bytes, rows, phrase length, the two optional tokens per phrase,
expanded forms, alternatives, definition paragraphs per form, and trie states.
Exceeding a limit disables glossary annotation for that governing-graph
version with one bounded diagnostic; ordinary Markdown rendering continues
unchanged. It must never fall back to a per-character regex or phrase loop.

## In-memory resolution and compiled cache

The server owns the canonical governing-glossary and include-graph resolver and
holds parsed glossaries and compiled automata in process memory. V1 has no
persistent cache format, database table, app-data cache file, project-local
cache, or restart-recovery obligation. Governing include closures are expected
to remain below 1,000 entries, so parsing and compilation after a server start
are bounded ordinary work.

Governing-file and include-candidate discovery reuse
`ProjectPathIndex.findExisting` from
`packages/server/src/projects/projectPathIndex.ts`. Its lazy directory listings
and directory-mtime validation maintain current presence and absence for each
single source-context resolution. See
[project-path-links](project-path-links.md) for that index's contract.

Directory mtime identifies which glossary path exists, but editing an existing
glossary need not change its parent directory. The compiled cache therefore
maps a governing canonical path to the ordered canonical dependency paths,
their file identities, parsed rows, and compiled automaton. Unchanged dependency
identities reuse that structure across files, sessions, and Source Control views
for the life of the server process. A changed dependency rebuilds the closure;
a changed directory listing re-runs governing or include selection. Successful
and failed bounded compilations are cached by the same dependency identity so
a bad graph cannot cause repeated work on every render.

While at least one client subscribes to a project's glossary paths, the server
holds one reference-counted project watcher. Subscription begins with the
complete project-relative set of files named exactly `GLOSSARY.md` and a
monotonic process-local generation. It then emits one `create`, `modify`, or
`delete` notification for each glossary-path change. The watcher is independent
of source paths previously queried by the client and is torn down when its last
subscriber disconnects. A bounded periodic check covers missed native watcher
events while the subscription remains live; it must not survive without a live
subscriber.

The client maintains the glossary-path hierarchy. Modification invalidates
cached artifacts whose dependency list names the changed glossary. Creation,
deletion, or rename invalidates cached source contexts below the changed
glossary's directory because nearest-governing resolution may have changed.
An initial subscription snapshot after reconnect lets the client detect missed
changes without retaining per-source subscription state on the server.

File-identity checks in the artifact resolver remain authoritative even with
notifications: an artifact request validates the actual current dependency
graph before reuse. Notifications provide prompt cache invalidation; they do
not weaken the resolver's correctness boundary.

All glossary-specific cache state may disappear on server restart. If later
measurement shows cold parsing or compilation to be material, a persistent
cache below YA app data may be proposed then; it is neither required nor
preferred for v1 and must never write inside the selected project or its Git
metadata.

Glossary initialization is lazy, asynchronous, and single-flight. With the
preference enabled, the first glossary-relevant session or file visit starts a
separate artifact request without delaying the session, message, or file
response that can render ordinary unannotated Markdown. Another artifact
request for the same project and unresolved governing-graph version awaits the
existing promise rather than starting duplicate path validation, parsing, or
compilation. This wait belongs only to glossary initialization; it must never
hold the displayable content response behind a possible glossary result.

When the artifact becomes ready, the owning Markdown renderer re-renders from
its original source or sanitized renderer output and replaces the speculative
unannotated presentation. It does not search and mutate the mounted document.
Streaming renderers retain the original block augment needed to apply the same
artifact to already-received blocks. A stale completion is ignored when its
project, governing source path, or dependency version no longer matches the
current render.

For a bounded valid glossary graph, initial path validation, parsing, and
compilation should complete in under one second on the project's ordinary
development baseline. This is a cold-work budget rather than permission to
block first paint. Aggregate limits and ordinary unannotated rendering remain
the fallback when a graph cannot be compiled safely.

Client render boundaries consume the same serializable compiled artifact
rather than implementing another parser or matcher. The authenticated delivery
contract is one optional-source request,
`GET /api/projects/:projectId/glossary-artifact[?sourcePath=...]`, plus one
project-scoped glossary-path subscription. Omitting `sourcePath` selects the
project-root assistant-prose context. Subscription starts with all glossary
paths and their generation, then reports additions, modifications, and
deletions. For server-rendered HTML, annotation transforms the sanitized
renderer output before insertion; it is not a document-wide mounted-DOM
rewrite. An older server's missing `glossary-tooltips` capability means the
client makes no unsupported request or subscription and renders ordinary
Markdown without glossary annotations.

## Render-boundary implementation plan

The detailed, source-anchored task is
[`docs/tactical/087-glossary-tooltip-implementation.md`](../docs/tactical/087-glossary-tooltip-implementation.md).
Its intended sequence is:

1. **Grammar and phrase-automaton compiler.** Add a browser-free shared
   glossary parser, recursive contained includes, finite surface-form
   expansion, multi-paragraph terminals, serialized trie format, matcher, and
   adversarial budget tests.
2. **Governing-glossary resolver and in-memory cache.** Reuse
   `ProjectPathIndex.findExisting` for contained ancestor and include lookup,
   then add dependency-identity invalidation, current-working-tree Source
   Control semantics, process-memory bounds, and bounded diagnostics.
3. **Compatibility review.** Inspect the required stable-server corpus and
   approve an optional permanent capability plus exact absent-capability
   fallback before adding the client delivery contract.
4. **Non-blocking artifact readiness.** Start one background, capability-gated
   artifact request from a relevant project visit, share concurrent work, and
   publish a versioned ready result without delaying ordinary content.
5. **Shared Markdown annotation boundary.** Feed the matcher into each owning
   Markdown renderer. Annotation happens on parsed tokens or sanitized renderer
   output before insertion, never through a document-wide mounted-DOM search.
6. **Term interaction and style.** Add one semantic term primitive and extend
   the shared tooltip coordinator for activation reveal/copy, Native/Themed
   ownership, keyboard behavior, selection precedence, and clipboard failure.
7. **Surface parity.** Wire assistant prose, FileViewer, Read/Write, fixed-font
   Markdown, Edit/diff, Source Control, standalone local documents, and bounded
   public-share contexts; raw/source modes remain untouched.
8. **Performance and visual acceptance.** Benchmark cold compilation, warm
   process-memory reuse, and linear scans; then capture and inspect desktop and
   phone renders with ordinary, hovered, focused, and tapped terms.

The shared compiler, resolver, and renderer annotation are the owning
invariants. Individual viewers must not grow bespoke glossary regexes, ancestor
walks, or click handlers.

## Verification plan

Grammar and matcher tests cover:

- no-bold phrases, one and several bold spans, edge and intervening optional
  tokens, the two-optional-token cap, comma alternatives, and escaped commas;
- independently present/absent optional tokens, rejection of a third optional
  token, and rejection of arbitrary gaps;
- case, Unicode, whitespace, punctuation, phrase-edge boundaries, and matches
  spanning ordinary inline formatting;
- same-form definitions within and across glossaries, concatenated paragraph
  order, overlap precedence, and stable source offsets after normalization;
- state/byte/row limits, file-identity invalidation, failed-compilation
  caching, and process-memory bounds; and
- a long nonmatching document proving scan work is independent of glossary row
  count and maximum phrase length after compilation.

Resolution tests cover same-directory and nearest-ancestor governing selection,
root-governed project prose, independent multi-file diff sections, project-
relative and referring-directory-relative includes, transitive cycles,
canonical deduplication, self-exclusion, containment and symlink escape,
current-working-tree Source Control behavior, deletion/rename, public-share
scoping, dependency-change invalidation, warm in-process reuse, cold rebuild
after server restart, and no glossary-cache writes to the project or YA app
data.

Renderer and interaction tests cover every Markdown-eligible surface, the
source/raw exclusion, existing links/code/KaTeX/tooltips, original-text copy,
selection precedence, Native/Themed exclusive ownership, mouse hover, touch
reveal, exact clipboard text, keyboard reveal/copy, and clipboard failure.

Final browser captures at 1920×1080 and 375×812 confirm a slight
non-underlined tint without layout shift, readable tooltips in both light and
dark themes, and a touch reveal that does not obscure the triggering term or
leave stale tooltip state.

## Acceptance boundary

The feature is complete when, after asynchronous artifact readiness, every
Markdown-render-eligible YA view uses one governing current glossary and the
same project-contained include semantics, compiled artifact,
multi-definition paragraphs, match precedence, metric-neutral visual
treatment, and reveal/copy interaction; warm scans are linear in rendered
text; first paint never waits for glossary compilation; and browsers with the
preference disabled, projects without a controlling glossary, and surfaces in
source/raw mode remain observably unchanged.
