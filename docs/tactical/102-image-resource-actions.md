# Image Resource Actions

Status: implemented and verified on 2026-08-09.

Topic: media-rendering-and-routing
Topic: session-media-handles

Contracts:

- [`topics/media-rendering-and-routing.md`](../../topics/media-rendering-and-routing.md)
- [`topics/session-media-handles.md`](../../topics/session-media-handles.md)

## Origin

Images referenced from rendered Markdown and images returned by tools use
different transcript chrome and interaction rules. Both are clickable, but a
Markdown inline preview currently copies pixels while a normalized tool-result
preview opens the image viewer. The file context menu also deliberately skips
local-media links, leaving image paths without the precise relative/absolute
copy choices available to text files.

The first convergence pass is client-only. It uses existing authenticated
local-image, project-file, attachment, and opaque session-media byte sources.
It does not add a server response field, expose internal preserved-media
locations, or turn a raw media response into a stable viewer link.

## Product direction

- Ordinary activation of an image name, thumbnail, or expanded preview opens
  the shared full image viewer. Disclosure controls only expand or collapse an
  inline preview; copying pixels is an explicit action.
- Right-clicking an image name, link, thumbnail, or expanded preview opens one
  resource-action menu. **Open** and **Download** are direct actions when the
  bytes are available. **Copy** contains **Image** plus only the path and
  viewer-link coordinates the source actually owns.
- A local or project-backed image may expose project-relative, absolute, or
  otherwise unclassified file paths. An image embedded as JSONL data or served
  by an opaque session-media handle has no filesystem path merely because YA
  can display or preserve its bytes.
- A preserved content-addressed blob path is internal storage, not user file
  identity. It is never offered as an absolute path or viewer link.
- Markdown links remain compact prose and tool images remain ordered activity
  rows. They share image affordances, preview treatment, and the full viewer;
  they do not erase the distinction between prose and tool activity.
- Existing public-share rules continue to hide host absolute paths. An action
  absent in the current view is omitted rather than guessed or disabled.

## Implementation plan

### 1 — generalize the resource action menu

Keep the existing hover/tap submenu behavior while making the callback-driven
menu usable by files and images. Add optional Download and Copy image actions,
and retain exact path-coordinate and stable-viewer-link labels.

### 2 — share image byte operations

Represent image display metadata separately from its byte source and optional
semantic file coordinates. Reuse one relay-safe fetch path for preview,
full-view, download, and clipboard operations, including the current PNG
clipboard conversion where required.

### 3 — converge transcript image interactions

Wire rendered Markdown/local-media links and hydrated previews, normalized
tool-result media rows, legacy path-backed `ViewImage` and image `Read`
fallbacks, turn-gallery thumbnails, and the full viewer. Use the tool input
path only where it unambiguously identifies the displayed result.

### 4 — align image presentation without flattening context

Use common disclosure sizing, filename/suffix treatment, dimensions format,
preview containment, and full-view behavior. Preserve tool identity/status on
activity rows and compact source position for prose links.

### 5 — prove capability-shaped menus

Test path-backed and pathless menus, pixel copy/download fetches, Markdown
delegation from both links and hydrated image pixels, tool-media lazy loading,
ordinary-click viewer behavior, desktop hover flyouts, touch panels, and
public-share path redaction.

### 6 — preserve the future server boundary

Update the owning topics with the observable client contract and retain
server-backed follow-ups for stable session-media viewer URLs, authoritative
optional source coordinates, public-share sanitization, and explicitly durable
availability.

## Acceptance

- Left-click opens the full image viewer on every in-scope image surface;
  disclosure buttons only change inline expansion.
- Right-click reaches the same image action vocabulary from names, links,
  thumbnails, expanded previews, galleries, and the full viewer.
- Copy image and Download work through direct and relay transports without bare
  API image URLs.
- Path actions appear only for a trustworthy semantic source path. JSONL data,
  opaque handles, and preserved blob locations do not manufacture paths.
- Markdown and tool rows have consistent image chrome while retaining their
  distinct prose/activity roles.
- Focused and full client tests, lint, formatting, typecheck, CSS checks,
  console/i18n scans, and fresh desktop/mobile browser verification pass
  without new warnings.

## Verification

- Focused image-action, rendered-Markdown, normalized tool-media, legacy
  renderer, project-viewer, and modal tests cover path-backed/pathless
  capabilities, relay byte loading, disclosure/open behavior, and public-share
  redaction.
- The complete client test suite passes. Its pre-existing
  `AppearanceSettings` `act(...)` diagnostics remain outside this surface; the
  focused changed-area runs and fresh browser console are warning-free.
- Typecheck, lint, format check, CSS architecture checks, console-chatter
  ratchet, i18n advisory scan, and diff whitespace checks pass.
- Fresh worktree dev-server captures at 1920×1080 and 375×812 verify aligned
  Markdown/tool previews, desktop hover flyouts, the phone replacement panel,
  stable in-project viewer links, full-view context actions, and menu-first
  Escape handling.
