# File Viewer Action Modes

Status: implemented and verified on 2026-08-09.

Topic: media-rendering-and-routing
Topic: active-content-security

Contracts:

- [`topics/media-rendering-and-routing.md`](../../topics/media-rendering-and-routing.md)
- [`topics/active-content-security.md`](../../topics/active-content-security.md)

## Origin

Rendered transcript paths currently reach one of two client viewers. A path
owned by the active project opens `FileViewer`; another allow-listed path opens
`LocalFileModal`. The branch changes both presentation and context-menu copy
semantics: HTML can arrive as source in one viewer and as a preview in the
other, while **Copy URL** can mean a stable YA viewer route or a raw
`/api/local-file` response.

The first convergence step is deliberately client-only. It uses the existing
project-file and local-file fetch contracts, makes the requested presentation
explicit, and labels copied values by what they are. It does not add project
ownership discovery, a new viewer route, or an executable-content service.

## Product direction

- A file with both meaningful source and static preview presentations exposes
  **Open > Source / Preview** in the file context menu. A file with only one
  useful presentation keeps a direct **Open** action.
- **Copy** is one top-level branch. Its second panel names the value precisely:
  **Project-relative path**, **Absolute file path**, **File path** when the
  stronger classification is unavailable, **Viewer link**, and **Contents**.
- A **Viewer link** is a stable YA application route. A raw API URL is not
  relabeled or copied as a viewer link.
- The second panel is selected rather than hover-only, so the same interaction
  works on touch. On a fine hover-capable pointer it also opens as an adjacent
  flyout when the branch is hovered. Compact/touch presentation includes an
  explicit **Back** action.
- Ordinary Markdown behavior remains preview-first. Ordinary HTML behavior is
  source-first. An explicit HTML preview stays scriptless and opaque-origin;
  selecting Preview never navigates to the raw file response.
- Images and other single-presentation resources do not acquire a meaningless
  source/preview choice.

## Implementation plan

### 1 — group file actions by intent

Replace the flat shared context menu with Open and Copy branches. Keep New
session at the top level, preserve dismissal and viewport clamping, and use
the shared menu at project-file, rendered-resource, and open-viewer call sites.

### 2 — carry the requested file presentation

Carry `source | preview` as client modal state from the selected menu action.
Teach `FileViewer` to statically preview HTML as well as Markdown, and teach
`LocalFileModal` to request Markdown source or rendered output deliberately.
Normal clicks continue to select the safe per-type default.

### 3 — contain static HTML previews

Wrap preview content in a client-owned document with a restrictive CSP, render
it through an iframe with an empty sandbox and no referrer, and reuse that
boundary in both viewers. No preview receives scripts, forms, workers, frames,
network connections, or authenticated YA authority.

### 4 — prove menu and viewer parity

Add component tests for touch-compatible branch navigation, exact copy labels,
stable-viewer-link behavior, project HTML source/preview choice, local HTML
source-first behavior, Markdown preview/source requests, and the sandbox/CSP
boundary.

### 5 — document the remaining server boundary

Update the owning topics with the observable client behavior and retain the
server-backed follow-ups: inert raw active-file responses, stable viewer URLs
for arbitrary allow-listed files, cross-project ownership resolution,
relay-capable relative-asset brokering, and isolated origins for executable
applications.

## Acceptance

- Both rendered-resource and project-file context menus use the same Open and
  Copy vocabulary.
- Source and Preview open the requested representation without a raw active
  navigation.
- HTML defaults to source; Markdown retains its established preview default.
- Preview iframes have an empty sandbox, a restrictive client-owned CSP, and a
  no-referrer policy.
- Copy labels distinguish path coordinates from stable viewer links, and raw
  local API URLs are absent from the Copy panel.
- Desktop and phone-width captures show usable first- and second-level menus.
- Desktop branch hover opens the corresponding adjacent flyout without a
  click; click/tap remains a complete path through the same actions.
- Focused tests, lint, formatting, typecheck, and CSS checks pass. Advisory
  i18n and console scans add no findings beyond their checked-in baselines.
- The relevant browser interaction passes without a stale-runtime banner or
  client warning.

## Verification

- All 381 client test files pass (3,378 tests). The focused file-action,
  viewer, path-helper, and catalog set passes 81 tests without warnings.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm css:check`,
  `pnpm console:scan`, and `pnpm i18n:scan` pass their repository contracts.
  The i18n scan retains its three pre-existing development-server findings;
  the console baseline is unchanged.
- `pnpm css:touched` found no bounded extraction in the touched legacy owners:
  their styling is scattered across 28–66 coupled or generated-vocabulary
  edges. All new styling is in component-owned CSS modules.
- Fresh-server captures at 1920×1080 and 375×812 verify the root, Open, and
  Copy panels. Fresh live interaction also verifies source-first HTML and the
  responsive preview. The final iframe has an empty `sandbox`, a client-owned
  CSP, `referrerPolicy="no-referrer"`, and no tooltip overlay; the browser
  console is clean.
- A full monorepo `pnpm test` attempt was not used as feature evidence: it
  reached 3,827 passing server tests but failed 14 unrelated server lifecycle,
  public-share, and descriptor-race tests, including teardown-time
  `setTimeout is not defined` errors. No server source changed here.

## Interaction follow-up — 2026-08-09

The initial selectable replacement panel worked on touch but felt unlike a
conventional desktop context menu because Open and Copy required a click.
Fine-pointer hover now opens the corresponding submenu beside the root menu;
the active branch remains highlighted and moving to a normal root action
closes the flyout. Click continues to open that flyout, while coarse pointers
and narrow viewports retain the replacement panel and explicit Back action.

A fresh browser pass against the real shared component verified both Open and
Copy hover flyouts with the root menu still visible. At 375×812, pointer
movement alone kept one root menu open and a deliberate tap replaced it with
the Open panel and Back action. The browser console remained clean.
