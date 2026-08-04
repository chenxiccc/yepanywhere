# Glossary Tooltip Implementation

Topic: glossary-tooltips

Status: Planned 2026-08-04. Product and architecture decisions below are
settled; implementation has not started.

## Goal and governing contract

Implement the behavior specified in
[`topics/glossary-tooltips.md`](../../topics/glossary-tooltips.md): when a
browser opts in, every Markdown-render-eligible project surface uses one
governing current `GLOSSARY.md` plus its explicit, project-contained include
graph to annotate matching prose with copyable definitions.

The feature must preserve ordinary display as the fast path. Opening a session
or file never waits for glossary discovery or compilation: YA first displays
the existing unannotated Markdown result, starts one background artifact
request, and re-renders at the owning render boundary when the versioned
artifact arrives.

Related contracts:

- [`topics/glossary.md`](../../topics/glossary.md) — glossary table format and
  project vocabulary;
- [`topics/rich-text-rendering.md`](../../topics/rich-text-rendering.md) — the
  eligible Markdown surfaces and source/raw exclusions;
- [`topics/ui-architecture.md`](../../topics/ui-architecture.md) — behavior
  belongs at the render boundary; `TooltipLayer` owns ordinary text hints;
- [`topics/vanilla-defaults.md`](../../topics/vanilla-defaults.md) — novel
  behavior is configurable and default-off;
- [`topics/project-path-links.md`](../../topics/project-path-links.md) — the
  existing lazy project-path index and containment model; and
- [`topics/server-capabilities.md`](../../topics/server-capabilities.md) and
  [`topics/remote-hosted-compatibility.md`](../../topics/remote-hosted-compatibility.md)
  — optional client/server feature gates.

## Initial decisions

### Default-off browser preference

Add **Glossary hints** to Appearance as a browser-local boolean, default
`false`, backed by a new `UI_KEYS` entry in
`packages/client/src/lib/storageKeys.ts`. Wire it through the immediate-apply
and pane-open Undo flow already assembled by
`AppearanceSettings` in
`packages/client/src/pages/settings/AppearanceSettings.tsx`. Add only English
copy to `packages/client/src/i18n/en.json`.

The preference is necessary but not sufficient: an in-scope `GLOSSARY.md` is
the content prerequisite. With the preference off, no artifact request is
made, no term is focusable, and the mounted output is observably the current
Markdown UI. Projects without a glossary remain unchanged even when the
preference is on.

### Process-memory indexes only

V1 persists no path trie, parsed glossary, include graph, matcher artifact, or
dependency fingerprint. `getProjectPathIndex` in
`packages/server/src/projects/projectPathIndex.ts` remains the shared
process-memory path authority. A new glossary service holds only process-memory
parsed files, dependency closures, successful/failed compiled artifacts, and
in-flight promises. Server restart is an intentional cold start.

The first relevant enabled visit starts lazy work. A supported, bounded cold
path—path validation, glossary reads, parse, include resolution, and compile—
should finish in under one second on the ordinary development baseline. That
budget is measured, not used to delay first paint or to introduce persistent
state.

### Non-blocking display and single-flight initialization

Use a dedicated optional glossary-artifact request. Session messages and file
responses continue on their current routes and render immediately without
annotations. The client starts the artifact request as background work and may
show no loading chrome.

The server keys in-flight work by canonical project plus requested governing
source context. A second artifact request that resolves to the same unfinished
governing graph awaits that promise; it does not start a duplicate ancestor
walk, read, parse, or compile. This is the only allowed wait. A content route
must not await an artifact merely because another caller started one.

Completion publishes an immutable artifact with its dependency/version
identity. The current render checks that identity and its project/source
context before applying it. If the user navigated, disabled the preference, or
received a newer dependency version, the stale completion is ignored.

### Re-render before insertion, not mounted-DOM search

The server returns one serialized matcher representation. The browser applies
it at renderer-owned boundaries to the original Markdown render input:

- sanitized server HTML is transformed as a detached fragment before
  `dangerouslySetInnerHTML` insertion;
- client-rendered fixed-font Markdown is transformed while building its render
  result; and
- streaming keeps each block's original augment HTML so artifact readiness can
  deterministically regenerate already-received blocks.

The transformer may flatten eligible adjacent text nodes across ordinary
inline formatting, map selected matches back to node offsets, and emit semantic
term wrappers. It must stop at links, code, raw HTML, KaTeX, controls, and
existing tooltip owners as the topic specifies. It must not scan arbitrary
mounted document text, infer terms from the page after rendering, or attach
view-specific click handlers.

This extends the existing boundaries rather than replacing them:

- `renderSafeMarkdown` in
  `packages/server/src/augments/safe-markdown.ts` remains the canonical safe
  Markdown renderer;
- `RenderedHtmlIsland` / `TextBlock` in
  `packages/client/src/components/blocks/TextBlock.tsx` owns completed assistant
  HTML;
- `MarkdownPreview` in
  `packages/client/src/components/MarkdownPreview.tsx` owns file and tool
  Markdown HTML;
- `useStreamingMarkdown` in
  `packages/client/src/hooks/useStreamingMarkdown.ts` owns streamed block HTML;
  and
- `FixedFontMathToggle` in
  `packages/client/src/components/ui/FixedFontMathToggle.tsx` owns the
  client-rendered fixed-font path.

### Metric-neutral term styling

The semantic wrapper may change foreground tint and decoration paint only. It
inherits font family, font size, font weight, line height, and letter spacing;
has no padding, margin, border width, minimum size, generated content, or
inline-size contribution; and does not replace text with a different glyph
sequence. Turning hints on or applying a newly ready artifact must preserve
line breaks, line-box height, measured text width, selection offsets, source
line targets, and scroll anchoring.

Use a co-located CSS module owned by the term primitive. Do not add a global
Markdown class rule merely because the term originates in generated HTML.
`pnpm css:check` and `pnpm css:touched` are required for the eventual style
change.

### Capability and fallback shape

Propose one permanent `glossary-tooltips` server capability and one schema-
versioned artifact format. The natural authenticated route shape is
`POST /api/projects/:projectId/glossary-artifacts`, accepting a bounded set of
project-relative source contexts and returning the governing context key,
artifact version, dependency identity, serialized automaton, and bounded
diagnostics for each distinct result.

The exact route and fields remain behind the mandatory compatibility review in
step 4. The absent-capability behavior is already decided: hide or disable the
unsupported preference, make no glossary request, and render ordinary
Markdown. Do not broaden an existing capability to cover this contract.

### Public shares and standalone documents are explicit boundaries

An authenticated project artifact route must not be reused from a public
share. Public shares receive only an artifact compiled from glossary files
already present in the share capability/snapshot; otherwise they remain
unannotated.

`renderMarkdownDocument` in
`packages/server/src/routes/local-file.ts` currently emits a standalone HTML
shell, while the main file path uses `renderMarkdownFilePreview` from
`packages/server/src/augments/markdown-file-preview.ts`. Preserve the one safe
Markdown renderer, but give the standalone shell an explicit bounded artifact
bootstrap or move it onto the shared `FileViewer` presentation. Do not add an
unscoped project API call or a general DOM text scanner to that document.

## Source map

| Concern | Current owner | Planned seam |
| --- | --- | --- |
| Project-relative existence | `packages/server/src/projects/projectPathIndex.ts` — `getProjectPathIndex`, `findExisting`, `validateDirectory` | Batch ancestor/include candidates; reuse its mtime validation and per-directory single flight |
| Safe Markdown parsing | `packages/server/src/augments/safe-markdown.ts` — `renderSafeMarkdown` | Preserve safety/exclusion structure and expose stable annotation boundaries if detached HTML lacks enough token provenance |
| Completed assistant augments | `packages/server/src/augments/markdown-augments.ts` — `renderMarkdownToHtml`, `augmentTextBlocks` | Continue producing canonical unannotated HTML; client decorates it when an artifact is ready |
| Streaming assistant augments | `packages/server/src/augments/augment-generator.ts`; `packages/client/src/hooks/useStreamingMarkdown.ts` | Retain original block HTML, transform before insertion, and reapply all live blocks on artifact-version change |
| File Markdown | `packages/server/src/augments/markdown-file-preview.ts`; `packages/server/src/routes/files.ts`; `packages/client/src/components/MarkdownPreview.tsx` | Carry project/source context beside HTML and transform through one preview boundary |
| Read/Write tool Markdown | `packages/server/src/augments/read-augments.ts`, `write-augments.ts`; client `ReadRenderer.tsx`, `WriteRenderer.tsx` | Propagate the tool target path to the same preview boundary |
| Edit and Source Control diffs | `packages/server/src/augments/edit-augments.ts`, `packages/server/src/git/diffResult.ts`; client `EditRenderer.tsx`, `UnifiedDiff.tsx`, `SideBySideDiff.tsx` | Resolve each target path independently and annotate only Markdown-rendered lanes |
| Client fixed-font Markdown | `packages/client/src/components/ui/FixedFontMathToggle.tsx` | Use the same serialized matcher during the existing rich-content render pass |
| Tooltip coordination | `packages/client/src/components/ui/TooltipLayer.tsx`; `packages/client/src/hooks/useTooltipAppearance.ts` | Add semantic glossary activation/reveal/copy without duplicating placement and dwell logic |
| Browser setting | `packages/client/src/lib/storageKeys.ts`; `packages/client/src/pages/settings/AppearanceSettings.tsx` | Add default-off preference, immediate apply, search metadata, backup/undo coverage |
| Capability registry | `packages/shared/src/server-capabilities.ts`; `packages/server/src/routes/version.ts`; `packages/client/src/hooks/useVersion.ts` | Register permanent capability and gate every request |

## Ordered implementation

### 1 — freeze grammar fixtures and resource budgets

Build table-driven fixtures directly from the topic before plumbing any UI.
Include nested emphasis, escaped commas, optional tokens, multi-definition
paragraphs, Unicode boundaries, cross-inline matches, overlap precedence, and
every exclusion boundary.

Choose centralized numeric limits for include depth, files, bytes, rows,
alternatives, phrase length, expanded forms, paragraphs per form, and trie
states. Derive values from synthetic fixtures representing a generous
sub-1,000-entry graph; do not scatter literals through parser and service code.
An exceeded limit returns one bounded disabled result and never selects a
slower matcher.

### 2 — implement the shared grammar, artifact, and matcher

Add a browser-free shared glossary package under
`packages/shared/src/glossary/` containing:

- first-table row parsing and plain-text definition flattening;
- comma/escape and bold-required phrase parsing;
- finite optional-token expansion and exact-form deduplication;
- deterministic terminal metadata and overlap ordering;
- Aho–Corasick-style trie/failure-link compilation;
- an explicitly versioned serializable artifact schema; and
- a linear matcher returning original visible-source spans.

Keep filesystem resolution and HTML/DOM adaptation outside this package. Test
serialization round trips and prove a long nonmatch scan does not multiply by
row count or maximum phrase length.

### 3 — resolve governing glossaries and cache compiled closures

Add a server service near `packages/server/src/projects/` or
`packages/server/src/services/` with one explicit owner. It should:

1. batch nearest-ancestor `GLOSSARY.md` candidates through
   `ProjectPathIndex.findExisting`;
2. read the governing file, discover project-relative and referring-directory
   include candidates, and enforce realpath containment;
3. traverse first-seen includes depth-first in source order;
4. fingerprint every dependency strongly enough to detect an edited existing
   glossary even when its parent-directory mtime is unchanged;
5. cache successful and bounded-failure artifacts by ordered dependency
   identity; and
6. share in-flight resolution/compile promises among equivalent requests.

Use current working-tree glossaries for historical Source Control views. Add
optional eager invalidation from successful YA-observed file mutations only
after authoritative dependency validation works; shell and human edits must
still be detected without that signal.

### 4 — approve and add the optional artifact contract

Before editing the client/server contract, inspect the latest two stable server
releases and every stable release from the preceding 14 days as required for an
optional feature. Record which lack the proposed route, fields, and capability.
Then obtain maintainer approval for this exact shape or its source-informed
replacement:

> Compatibility review for glossary tooltips: releases `<corpus>` lack
> `POST /api/projects/:projectId/glossary-artifacts` and the
> `glossary-tooltips` capability. I propose that permanent capability and a
> versioned artifact response; without it the client hides or disables
> Glossary hints, makes no artifact request, and renders ordinary Markdown.
> Existing capability meanings and older capable behavior remain unchanged.
> Approve?

After approval, add a dedicated route module, mount it with the project routes
in `packages/server/src/app.ts`, register its complete contract in
`packages/shared/src/server-capabilities.ts`, export shared request/response
types, and cover direct plus relay transport. The request must be bounded and
path-contained; diagnostics must not disclose glossary text or escaped paths.

### 5 — start background readiness from project render contexts

Add one client artifact store keyed by server identity, project id, governing
source context, artifact schema version, and dependency version. A relevant
enabled session/file visit asks the store to ensure its needed contexts. The
store renders through the initial `empty/not-ready` state, shares promises, and
publishes immutable ready artifacts to subscribed renderers.

Do not attach this to provider-process activation or server session liveness:
glossary work is presentation data and must not wake or retain a provider. A
closed tab has no continuing client obligation; server work already started may
finish and populate the process-memory cache.

Tests must demonstrate immediate unannotated render, one network request for
concurrent consumers, one server compile for equivalent contexts, re-render on
ready, stale-result rejection, disable-during-build behavior, and ordinary
fallback after server restart or request failure.

### 6 — add one detached-fragment annotation adapter

Implement the browser adapter at a shared Markdown render boundary. It accepts
sanitized HTML, one artifact, and an exclusion policy; returns annotated safe
HTML or a fragment plus semantic term metadata. It walks only that detached
render result, not the mounted page.

Map normalized match spans back across eligible text nodes without changing
their text. Reject matches that cross an excluded element. Never place
definition text in a text node: ordinary copy, browser search, source mapping,
and line alignment must continue to see only source prose.

Route completed assistant output through `RenderedHtmlIsland`, file/tool output
through `MarkdownPreview`, and streaming blocks through a transform callback in
`useStreamingMarkdown`. Retain unannotated block HTML separately so changing or
removing an artifact is reversible and does not recursively annotate prior
wrappers.

### 7 — implement the semantic term and tooltip interaction

Emit one recognizable glossary-term primitive with exact definition metadata
and no navigation behavior. Extend `TooltipLayer` rather than creating a
second positioned overlay. Preserve exclusive Native `title` versus Themed
`data-tooltip` ownership.

Add delegated pointer, touch, and keyboard behavior scoped to semantic term
targets: hover/focus reveals; primary activation reveals and copies; Enter and
Space do the same; non-collapsed selection wins; clipboard failure never claims
success. Ensure disabling the feature removes focusability and interaction.

Add a co-located CSS module and automated geometry assertions comparing the
same fixture before and after annotation: identical client rect width/height,
line count, scroll height, and selected plain text.

### 8 — propagate governing source context across every surface

Carry a small explicit render context—project id plus optional project-relative
source path—rather than letting viewers rediscover it from DOM or labels.

Wire in this order so each new surface inherits tested primitives:

1. completed and streaming assistant prose, governed by the root glossary;
2. `FileViewer` full/range Markdown and Read/Write target paths;
3. Markdown-eligible Edit previews and each multi-file Source Control section;
4. project-affiliated fixed-font rendered output;
5. standalone local Markdown documents; and
6. public-share snapshots/capabilities.

At every step add a paired raw/source assertion and an absent-artifact
assertion. Do not make glossary matching a reason to structurally render a code
file or non-Markdown diff.

For standalone documents, prefer convergence on shared `FileViewer` if it
preserves raw-link and line-target behavior. If the transitional shell remains,
its bootstrap must be narrowly scoped, covered by the active-content security
contract, and able to apply only a pre-authorized artifact.

### 9 — verify performance, parity, and visual behavior

Run focused unit/integration suites plus the project-wide warning-free checks:
`pnpm lint`, relevant server/client tests, `pnpm capabilities:audit`,
`pnpm i18n:scan`, `pnpm console:scan`, `pnpm css:check`, and
`pnpm css:touched`.

Record contrastive measurements for:

- first render with hints disabled versus enabled but artifact cold;
- cold bounded compile, with a target below one second;
- two concurrent initialization requests proving single flight;
- warm artifact reuse across sessions and file views;
- linear scan cost over long nonmatching text; and
- dependency edit, deletion, include change, and process restart.

Final fresh-server captures at 1920×1080 and 375×812 must cover unannotated
first paint followed by ready-state re-render, ordinary/hover/focus/touch term
states, light and dark themes, a multi-definition tooltip, and a raw/source
control. Inspect line breaks and adjacent baseline geometry before claiming the
metric-neutral contract.

## Suggested commit slices

Keep the series in local commit order and use `Topic: glossary-tooltips` on
each non-standalone slice:

1. shared grammar/artifact/matcher and limits;
2. server resolver, dependency cache, and single flight;
3. capability-approved route and client artifact store;
4. detached annotation boundary and streaming regeneration;
5. semantic interaction, preference, and metric-neutral style;
6. remaining file/diff/share surface parity and final contract evidence.

Do not combine public-share authorization work with the basic authenticated
route merely to reduce the commit count; they have different trust boundaries.

## Done condition

With **Glossary hints** enabled, opening a cold project session displays its
ordinary Markdown immediately, performs at most one equivalent glossary build,
and then re-renders every eligible visible surface with the governing current
glossary. The change preserves text metrics and copy/search/source alignment,
uses the existing tooltip coordinator, detects dependency changes without
persistence, and never exposes an unshared glossary. With the preference off,
without a governing glossary, on an older server, or in source/raw mode, YA is
observably unchanged and makes no unsupported glossary request.
