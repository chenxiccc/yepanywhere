# Media Rendering and Routing

> YA shows images, video, and file previews from many places in the UI. Every
> one must pull the bytes *over the active connection* and display them from an
> object URL — never point an `<img>`/`<a>` straight at an `/api/...` URL — or
> it silently 404s in relay mode. Separately, each file is served by the route
> that matches where it lives (in-project, allow-listed local path, uploaded
> attachment, or public share).

See also:
- [`ui-architecture.md`](ui-architecture.md) — the render-boundary principle
  these surfaces are supposed to share instead of each re-solving fetching.
- [`rich-text-rendering.md`](rich-text-rendering.md) — how rendered Markdown/HTML
  produces the local-resource links that several of these surfaces consume.
- [`relative-filenames.md`](relative-filenames.md) — how the same paths are
  *displayed* (compacted to project-relative) across these surfaces.
- [`attachment-storage.md`](attachment-storage.md) — where uploaded attachments
  live and the allow-list behind `/api/local-image` and `/api/local-file`.
- [`session-media-handles.md`](session-media-handles.md) — materialized
  tool-result media and transcript media handles that are fetched lazily
  instead of retained as inline base64.
- [`relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md) — why
  the relay origin has no API, and the public-share serving path.
- `docs/tactical/009-local-resource-link-routing.md` — the working log of the
  local-resource link/parser/modal build-out.

Topic: media-rendering-and-routing

## The connection rule (why media is different)

The client reaches the server two ways:

- **Direct** (`DirectConnection`) — localhost/LAN/Tailscale. The page origin
  *is* the YA server, so a plain `fetch("/api/...")` or `<img src="/api/...">`
  reaches it.
- **Relay** (`RelayProtocol` / `SecureConnection`) — the page is loaded from the
  hosted relay client (e.g. a static site), and the real server is on the far
  end of a WebSocket tunnel. **The page origin has no `/api` backend.** A native
  browser request to `/api/...` (an `<img src>`, an anchor navigation, a raw
  `fetch`) hits the static origin and 404s.

So in relay mode bytes can only arrive through `connection.fetchBlob(path)` over
the tunnel. The shared pattern across every surface is therefore: **fetch the
bytes as a `Blob` through the connection, wrap in `URL.createObjectURL`, render
that object URL.** Helpers that encapsulate this:

- `fetchMediaBlob` / `fetchLocalResourceBlob` (`components/LocalMediaModal.tsx`) —
  `connection.fetchBlob` when remote, credentialed `fetch` when direct.
- `useFetchedImage` / `useRemoteImage` (`hooks/useRemoteImage.ts`) — the hook
  form, returns an object URL.
- `RelayProtocol.fetchBlob` normalizes the `/api` prefix, so callers can pass
  either `/api/...` or `/...`.

The recurring bug is any surface that skips this and emits a bare API URL: it
works on the developer's own machine (direct mode) and 404s for everyone on a
phone through the relay. The base64 `data:` surfaces are immune (no network).

## Where media appears in the UI

Each surface below is named by *what the user is looking at*, then the component
and the route it pulls from.

### Inline in the transcript

- **Image-bearing tool result** — `Read`, `ViewImage`, and provider-neutral
  image-bearing results converge on the shared outline media row. Its `+ / -`
  toggle controls a lazy object-URL preview. Route:
  `/api/projects/:id/sessions/:sid/media/:mediaId`. Relay-safe. Legacy
  unmaterialized `Read` results retain their base64 renderer as a compatibility
  fallback.
- **Embedded media inside rendered Markdown/HTML** — an `![](...)` image or
  video that appears inline within an assistant/user message body.
  `useLocalMediaInlinePreviews` (`components/LocalMediaModal.tsx`) hydrates the
  `local-media-inline-preview` placeholders emitted by the server Markdown
  augment; it's wired from `blocks/TextBlock.tsx` and
  `renderers/blocks/TextRenderer.tsx`. Route: `/api/local-image`. Relay-safe.
- **Legacy path-backed ViewImage result** — a historical result without a
  media handle still opens its path through `LocalMediaModal` and
  `/api/local-image`. New live and durable results snapshot permitted paths
  into the session media store before rendering.

### Modals opened by clicking a link

- **File viewer modal (tool-result filename links)** — click a filename in a
  `Read`/`Edit`/`Grep`/`Write` row and a modal opens showing the file: code with
  highlighting, a Markdown preview, or — for images — the picture in the modal
  body. `SessionFilePathLink` → `FilePathLink` → `FileViewer` (in
  `FileViewerModal`). Routes: `/api/projects/:id/files` (metadata) and
  `/files/raw` (bytes). Relay-safe **as of the `fetchRawFileBlob` fix**; before
  that the image `<img src>` used the raw URL directly and 404'd in relay mode.
- **Local media modal (rendered-text media links)** — click an image/video link
  *inside* rendered Markdown/HTML and a modal shows it. `useLocalResourceClick`
  → `LocalMediaModal` → `/api/local-image`. Relay-safe.
- **Local file modal (rendered-text file links)** — click a non-media local file
  link in rendered text; a modal renders text/JSON/log inline, PDFs from a blob
  URL, and (direct mode) HTML/Markdown in a sandboxed iframe. `LocalFileModal`
  → `/api/local-file`. Relay-safe.

### Composer and new-session

- **Attachment chips** — image thumbnails on a sent user message and in the
  composer's pending-attachment row. `components/AttachmentChip.tsx` via
  `useRemoteImage` → `/api/projects/:id/sessions/:sid/upload/:filename`.
  Rendered from `MessageInput.tsx`, `MessageList.tsx`, and
  `blocks/UserPromptBlock.tsx`. Relay-safe.
- **New-session pending file preview** — a thumbnail in the new-session form for
  a file you've attached but not yet uploaded. `NewSessionForm.tsx`, using a
  local `File` object URL (pre-upload). No network, always works.

### Read-only shares

- **Public-share file viewer** — on a shared session page, clicking a file opens
  the same `FileViewer`, but backed by a share-scoped source
  (`publicShareFileViewerSource.ts`) that fetches `/public-api/shares/:secret/
  files/raw` through the relay+secret path. Relay-safe.

## Proposed refinement: anchored attachment hover preview

Current state: image attachment chips already show a full-image hover preview
after a brief linger (`AttachmentChip.tsx`, `HOVER_PREVIEW_LINGER_MS = 450`),
but the preview is a centered, viewport-fixed overlay. It does not choose a
direction from the thumbnail or avoid covering nearby context except by hiding
when the click modal opens.

Desired behavior for all image attachment thumbnails (composer, sent user
turns, and parsed user-prompt blocks):

- Keep the short hover delay so incidental cursor travel does not flash an
  image.
- Anchor the enlarged preview to the hovered thumbnail, not the center of the
  viewport.
- Choose the side with the most available space (prefer below/above when they
  can show the image at useful size; otherwise left/right), and flip when the
  first choice cannot fit.
- Resize the preview to fit inside the viewport with a small margin while
  preserving aspect ratio; never create page scrollbars or crop the image.
- Fetch/display bytes through the existing attachment preview path
  (`useCachedAttachmentImage` / `useRemoteImage`) so relay mode and cached
  thumbnail/full-image behavior stay unchanged.
- Leave touch behavior on the explicit click modal; hover-only enlargement is a
  desktop affordance.

## Compact turn image galleries

Status: implemented.

When **Expand Inline Media by Default** is enabled, several tall images in one
assistant turn can consume the visible transcript and push the turn's
informative text above the viewport. A completed final response can then look
like an interrupted response on return: the visible tail is mostly screenshots,
while the actual completion text is offscreen.

Appearance exposes **Compact Multi-Image Galleries** beside **Expand Inline
Media by Default**. The gallery setting enables one gallery capability for
completed assistant turns with two or more eligible linked images. **Expand
Inline Media by Default** controls only its initial visibility: with inline
expansion enabled, the gallery starts open; otherwise the ordinary compact
image links remain and a small **Gallery** action follows the final eligible
link in source order. Disabling the gallery setting removes that action and
restores the existing independent inline-preview behavior.

The gallery setting defaults on by explicit maintainer approval (graehl,
2026-07-29). This is a deliberate default-on exception under
[`vanilla-defaults.md`](vanilla-defaults.md): a gallery does not open unless the
user already requested automatic inline expansion, and the closed-state action
appears only where a turn has multiple images. It adds no provider behavior or
transcript content and avoids another global preference merely to govern that
one affordance.

The compact presentation is owned by the whole assistant turn, not by the
position of an image link within its text. Images anywhere in that turn are
eligible. One image retains the existing inline presentation. With two or more
eligible images and the gallery setting enabled, the per-image links and `+`
controls become image-specific entrances to the same turn gallery; the generic
**Gallery** action opens it at the last featured image, or the first source
image when none has yet been featured. With the gallery setting disabled,
manual and automatic per-image expansion retain their ordinary full inline
presentation.

The original image links remain at their original positions in the turn text.
Activating one opens the gallery when necessary, then scrolls to it and centers
and features that link's thumbnail. The gallery has one shared featured-item
caption rather than repeating captions below every thumbnail:

- On desktop, while the gallery is active, the pointer continuously features
  the nearest thumbnail across the browser viewport, including above or below
  the thumbnail rows and in their gaps. Opening the image viewer pauses this
  tracking so returning preserves the selected item. Keyboard focus features
  its item directly.
- In the horizontally swipeable phone row, the item nearest the row's center
  becomes featured as the user scrolls or drags.
- The original link label is the primary caption. The literal basename may
  appear as smaller, lower-emphasis secondary text when it differs and adds
  useful identity.
- Activating the featured caption scrolls back to and focuses that image's
  original link in the turn text.

Selecting the thumbnail itself opens the full-screen image viewer. Navigation
between the turn text and gallery therefore remains distinct from full-size
inspection.

The shared image viewer uses the useful viewport rather than the generic modal
preview ceiling. Selecting a thumbnail enters one maximized viewer state;
clicking anywhere in the image stage (including outside an off-center or
zoomed image), activating the visible **Close** control, or pressing Escape
returns to the gallery. Toolbar controls remain operable without dismissing
the viewer. Fit, 1:1, and stepped zoom are explicit inspection controls within
that one state, not further expansion levels. A 1:1 or otherwise zoomed image
remains scrollable and pannable instead of being clipped; trackpad pinch/wheel
zoom remains anchored near the pointer.

On touch screens, the gallery row retains its horizontal swipe behavior until
an image is selected. The selected image then owns a full-screen stage with
two-finger pinch zoom and one-finger pan, while closing it returns to the same
transcript/gallery position.

The viewer header exposes the basename as a link to the fetched full-resolution
image, and its explicit **Download** action saves those same fetched bytes under
that basename. Both use the relay-safe object URL; neither navigates the browser
to a bare API route.

The compact-gallery goals, in priority order, are:

- Where the turn is short enough, keep all of its informative text and the
  gallery visible together. Long turns make that impossible, so this is a
  target rather than a guarantee.
- Give the gallery at most roughly one third of the transcript viewport while
  a useful compact preview is possible. It may use less height when that lets
  the turn text fit.
- Keep relative reduction reasonably even: one screenshot should not become
  illegible merely so another can remain close to its normal inline size.
- Choose among the viable row counts by maximizing the smallest thumbnail
  height, preferring fewer rows on a tie. Do not split a row when dividing the
  same vertical budget would only make its images smaller.
- A thumbnail's rendered height must never exceed its natural pixel height.
  Natural-size caps may leave unused space or produce ragged alignment; do not
  upscale an image merely to align it with its row or fill the gallery.
- Use the available vertical budget without treating complete content-width
  fill as a goal. Rows may have different heights.
- Present ordinary completed rows as justified image rows. The final or
  pathologically sparse row may remain ragged; dead horizontal space is
  acceptable rather than enlarging images solely to consume it. Roughly 100
  pixels of leftover row width is an initial tuning signal, not a persistent
  format constant.
- Preserve each image's stable filename/identity and full-size target, but do
  not preserve image occurrence order as a presentation constraint. The
  gallery may reorder a turn's automatically presented images to improve
  legibility and packing. Filename references in the prose remain in their
  original transcript order.

A deterministic greedy row fill with one-image lookahead is a plausible first
layout strategy. Small bounded exact searches are also acceptable, but the
observable contract is balanced, stable packing rather than a globally optimal
permutation. The same image dimensions and available space should produce the
same arrangement, and small resize changes should not cause gratuitous
reshuffling.

The gallery has one turn-level **Dismiss gallery** action, with a keyboard
accelerator. Dismissing removes the reordered gallery and reinstates each image
as the existing minimal link and `+` affordance at that image reference's
original inline position. It also restores the small **Gallery** action beside
the final eligible link; that stable label is used for both an initially closed
gallery and a dismissed one, rather than introducing a distinct restore mode.
The transcript's original text/image-reference order is therefore always
recoverable even though gallery packing may reorder thumbnails. Activating a
specific image link restores the same deterministic gallery arrangement
centered on that image; activating **Gallery** restores it at the last featured
image. There is no second “dismiss to expanded inline images” state.

### Phone presentation and deferred gesture

On phone, a single horizontally swipeable thumbnail row is a reasonable compact
presentation. It spends horizontal overflow instead of shrinking several
screenshots into nearly unreadable fixed columns. A partially visible next
thumbnail can disclose the swipe affordance. Selecting an image opens a
scrollable, pinch-zoomable full-screen view, and returning preserves the
transcript position.

A post-v1 interaction experiment may combine selection and enlargement in one
two-axis gesture: horizontal finger movement scrubs through the row, while
moving the same drag upward toward the top of the screen enlarges the currently
centered image. This is not required for the first gallery implementation. It
needs touch testing for accidental activation and conflict with ordinary
vertical transcript scrolling, plus a complete tap/full-screen path for users
who do not discover or cannot perform the gesture.

## Which route serves the file (the "doors")

There are two routing systems and several serving routes. The serving route
determines the **permission model**, not just the URL.

Serving routes:

| Route | Access model | Source file |
|-------|--------------|-------------|
| `/api/local-image` | File-access allow-set (see below) | `routes/local-image.ts` |
| `/api/local-file` | Same allow-set (text/PDF/HTML/Markdown) | `routes/local-file.ts` |
| `/api/projects/:id/files` + `/files/raw` | Relative paths project-scoped; **absolute/`~` paths gated by the same file-access allow-set** | `routes/files.ts` |
| `/api/projects/:id/sessions/:sid/upload/:filename` | Files uploaded to that session | `routes/upload.ts` |
| `/api/projects/:id/sessions/:sid/media/:mediaId` | Authenticated session-scoped opaque tool-result handle | `routes/tool-result-media.ts` |
| `/public-api/shares/:secret/files/raw` | Share-scoped, capability-gated by secret | `routes/public-shares.ts` |

**The file-access allow-set** is one effective list enforced by **both** doors
(media routes and the project-files route), shared via
`routes/local-resource-policy.ts` (drive-letter/symlink-safe). It is the union
of user-toggled sources — projects ∪ uploads ∪ temp ∪ home ∪ custom — held live
in `middleware/file-access.ts` and editable in Settings → Local Access → File
access. `ALLOWED_FILE_PATHS` (alias `ALLOWED_IMAGE_PATHS`) pins it from the
environment. Secure by default: out-of-project absolute paths are denied unless
their folder is in the set. See `docs/tactical/018-file-access-scoping.md`.

Two client routing systems decide *which* surface a link opens:

- **Tool-result filename links** — `SessionFilePathLink` → `FilePathLink`. These
  always open the `FileViewer` against `/api/projects/:id/files`, regardless of
  whether the path is inside the project or an outside safe-dir path like
  `C:\tmp\...`. `getProjectViewerFilePath` only affects the *displayed* path, not
  the route.
- **Rendered-text links** — `useLocalResourceClick` parses each link into a
  `LocalResourceRef` (`local-media` | `local-file` | `project-raw-file`) using
  the shared `parseLocalResourceLink` (`packages/shared/src/local-resource.ts`).
  `normalizeResourceForProjectContext` sends *in-project* paths to the project
  `FileViewer`, and everything else to the `LocalMediaModal` / `LocalFileModal`
  (the allow-listed `/api/local-image` / `/api/local-file` doors).

The two routing systems still pick *different surfaces* for the same path, but
that no longer changes the **permission** outcome: both surfaces now resolve
against the same file-access allow-set. So a `C:\tmp` image that takes the
project-files route enforces the same allow-set as the media door would — the
historical "safe-dir image opened through the project files route" 404 is gone.

## Known sharp edges

- **Bare API URLs in relay mode** — the canonical failure. Fixed in the
  `FileViewer` by giving the default source a `fetchRawFileBlob`; watch for it
  in any new surface.
- **In-project vs. out-of-project routing** — tool-result links always use the
  project files route; rendered-text links split by location. The two systems
  don't share the in/out-of-project decision.
- **Both doors share one allow-set** — as of `docs/tactical/018`, the
  project-files route enforces the same file-access allow-set as the media
  doors for absolute/`~` paths (relative paths stay project-scoped). The set is
  secure-by-default, so absolute paths outside projects/uploads/temp are denied
  until the user adds the folder (Settings → File access) or sets
  `ALLOWED_FILE_PATHS`.
- **Context-specific media remains** — normalized tool-result images share one
  media row, and modal-based local images share `LocalMediaModal`; attachments,
  rendered Markdown placeholders, and the project `FileViewer` retain
  context-specific presentation. Cross-surface fixes still belong in a shared
  source adapter or the narrowest common rendering boundary.
