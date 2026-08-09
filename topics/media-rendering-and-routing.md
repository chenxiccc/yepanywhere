# Media Rendering and Routing

> YA shows images, video, and file previews from many places in the UI. Every
> one must pull the bytes *over the active connection* and display them from an
> object URL — never point an `<img>`/`<a>` straight at an `/api/...` URL — or
> it silently 404s in relay mode. Separately, each file is served by the route
> that matches where it lives (in-project, allow-listed local path, uploaded
> attachment, or public share).

See also:
- [`active-content-security.md`](active-content-security.md) — why HTML, SVG,
  and other active files must remain source/download data or execute only in
  an isolated origin, regardless of which transport fetched their bytes.
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
  URL, and an explicitly selected HTML/Markdown preview in a sandboxed iframe.
  `LocalFileModal` → `/api/local-file`. Relay-safe. HTML defaults to source;
  Markdown keeps its established preview default. The sandboxed modal is the
  only permitted HTML preview shape; open/new-tab actions must not escape it to
  an inline raw active response. See
  [`active-content-security.md`](active-content-security.md).

File-viewer modals own one same-URL browser-history entry: Back dismisses the
viewer without leaving the underlying session, while opening or React effect
replay must never traverse pre-modal history.

### Resource actions and file presentation choice

Project-file links and rendered local-file links share one client context-menu
vocabulary even though their authorization routes remain distinct:

- Files with meaningful source and static preview representations use a
  touch-selectable **Open > Source / Preview** panel. Other files keep a direct
  **Open** action. This is an initial-presentation choice, not a different file
  permission or serving route.
- On a fine hover-capable pointer, hovering **Open** or **Copy** opens an
  adjacent flyout and highlights the active branch, matching conventional
  desktop context menus. Click still opens the same flyout. Coarse pointers
  and narrow viewports use the compact replacement panel with an explicit
  **Back** action, so hover is never the only route to a submenu.
- HTML is source-first. Its explicit Preview is a client-owned `srcdoc`
  document under an empty iframe sandbox, no-referrer policy, and restrictive
  meta CSP. Markdown remains preview-first and may be opened as source. Both
  representations remain toggleable inside the project `FileViewer`; the
  local-file modal takes its initial representation from the context menu in
  this first convergence step.
- **Copy** opens a second panel whose labels describe the coordinate or value:
  **Project-relative path**, **Absolute file path**, **File path** when the
  client cannot classify it more strongly, **Viewer link**, and **Contents**.
  Only available, non-duplicate coordinates appear.
- **Viewer link** means a stable YA application viewer route. A raw
  `/api/local-file` or project raw-file response is never presented as a
  viewer link. Relay and direct clients therefore use the same meaning rather
  than changing the label according to transport.
- Public shares may expose their share-scoped viewer link and project-relative
  path, but the file action menu does not derive or copy the host's absolute
  project path.

This convergence is client-only and uses existing fetch contracts. The server
still needs separate future work to provide a stable viewer route for an
arbitrary allow-listed file, resolve a rendered path to another scanned
project's owner, and broker relative preview assets across direct and relay
transports. Until those contracts exist, an outside-project local file has no
copyable Viewer link, and static preview assets are limited to data/blob
resources admitted by the client preview CSP.

Images use the same callback-driven resource menu without pretending that
every byte source is a file:

- Ordinary activation of an image link, name, thumbnail, or expanded preview
  opens the shared full image viewer. The adjacent `+ / -` control changes
  inline disclosure only; it is not a second copy or open gesture.
- Right-click on rendered Markdown/local-media links and hydrated pixels,
  normalized tool-result filenames and previews, legacy path-backed
  `ViewImage` and image `Read` results, compact-gallery thumbnails, project
  viewer images, and the full image viewer opens the same resource menu.
- **Open** is direct. **Download** appears when the client has a byte source.
  **Copy** contains **Image** and only the semantic coordinates that exist:
  **Project-relative path**, **Absolute file path**, **File path**, and a stable
  **Viewer link**. An unavailable coordinate is omitted rather than disabled
  or inferred.
- Clipboard and download actions fetch through the active source transport.
  Copy image starts `ClipboardItem.write()` during the selecting gesture and
  supplies relay-delivered bytes as a pending PNG, so a slow relay round trip
  does not normally outlive browser user activation.
- A single normalized `ViewImage`, `ImageView`, or image `Read` result may use
  its unambiguous tool-input path as semantic source identity. Multi-image
  results and other image-producing tools do not inherit one guessed path.
- A semantic path inside the active project may derive the existing stable
  project `FileViewer` route and expose it as **Viewer link**. An allow-listed
  path outside that project still has no stable application viewer coordinate;
  its raw byte URL is not relabeled.
- JSONL-embedded data, opaque session-media handles, object URLs, and
  content-addressed preserved blobs are byte sources, not filesystem
  coordinates. Their menus still support Open, Download, and Copy image but
  do not manufacture path or viewer-link actions.
- Public shares may retain a safe project-relative coordinate and their
  share-scoped viewer URL. They never expose a host absolute path through an
  **Absolute file path** or fallback **File path** item.

Markdown image references remain compact prose while tool images remain
ordered activity rows with tool identity and status. Their disclosure control
size, filename/suffix treatment, preview border/background/containment, and
full-screen viewer behavior are aligned without flattening those two roles.

### Composer and new-session

- **Attachment chips** — image thumbnails on a sent user message and in the
  composer's pending-attachment row. `components/AttachmentChip.tsx` via
  `useRemoteImage` → `/api/projects/:id/sessions/:sid/upload/:filename`.
  The project coordinate comes from logical session metadata because app-data
  project keys are intentionally irreversible. The session coordinate comes
  from the attachment path's physical directory, which remains stable when a
  provisional or forked session id differs from the viewed session. Legacy
  `.attachments` and central-upload paths retain path-based fallback routing
  when no current session context exists. Rendered from `MessageInput.tsx`,
  `MessageList.tsx`, and `blocks/UserPromptBlock.tsx`. Relay-safe.
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
image links remain and a small **+ Gallery** action follows the final eligible
link in source order. While open, that action remains visible as **− Gallery**.
Disabling the gallery setting removes that action and restores the existing
independent inline-preview behavior.

The gallery setting defaults on by explicit maintainer approval (graehl,
2026-07-29). This is a deliberate default-on exception under
[`vanilla-defaults.md`](vanilla-defaults.md): a gallery does not open unless the
user already requested automatic inline expansion, and the closed-state action
appears only where a turn has multiple images. It adds no provider behavior or
transcript content and avoids another global preference merely to govern that
one affordance.

The compact presentation is owned by the whole assistant turn, not by one text
block or the position of an image link within it. Eligible images are linked
images in rendered Markdown text items across that turn. Image-bearing
`ViewImage`, `Read`, and provider-neutral tool-result rows retain their own
independent media controls and are not gallery candidates. One eligible image
retains the existing inline presentation. With two or more eligible images and
the gallery setting enabled, every per-image `+` control opens the same turn
gallery centered on that image. While the gallery is open, all of those
controls become `−`; activating any one collapses the whole gallery. The
generic **+ Gallery** action opens it at the last featured image, or the first
source image when none has yet been featured, and becomes **− Gallery** while
open. With the gallery setting disabled, manual and automatic per-image
expansion retain their ordinary full inline presentation.

### Proposed: galleries for adjacent image-producing activities

Status: proposal only; the implemented gallery still has the eligibility
boundary above.

Adjacent `ViewImage` actions and provider-neutral tool-result image rows should
eventually receive the same compact gallery and full-screen viewer treatment as
image links embedded in assistant text. This is not merely a matter of adding
their URLs to the turn-level image collector. A linked image is a reference
inside prose whose source position remains visible; a tool image is itself an
ordered activity row, with tool identity, status, disclosure state, and result
semantics that must not disappear when its preview moves into a gallery.

The proposed owner is therefore an outline-level image-activity group created
at the render-item/segment projection boundary:

- A contiguous run of completed image-bearing activities within one assistant
  turn forms one group when it contains at least two eligible images. One tool
  result may contribute several images. A single-image run keeps its ordinary
  row. Eligibility comes from normalized image media or an explicit
  `ViewImage` result, not filename or tool-name guessing.
- The group retains a source-ordered outline entry for every contributing
  activity and owns one gallery over their images. A non-image activity or
  prose boundary ends the run; the grouping must not pull separated actions
  together merely because they occurred in the same turn.
- Gallery packing may reorder thumbnails under the existing compact-layout
  rules, but it must never reorder the activity outline. Each thumbnail keeps a
  stable mapping to its source render item, tool/media identity, and original
  position. Captions and return-to-source navigation target that outline entry,
  while viewer previous/next order remains the original image order.
- Collapsing the gallery restores the source-ordered activity presentation and
  its normal media controls. Expanding it may relocate previews, but entering
  or leaving Conversation View must not erase user-selected disclosure state;
  keyed state restoration is sufficient and retaining the same mounted DOM
  instances is only a possible optimization.
- Conversation View treats the image-activity group as one activity-outline
  unit. Expanding that unit reveals both its ordered action entries and the
  related gallery rather than regenerating an unrelated collection of image
  rows.

This preserves the semantic trace while allowing the same compact visual
treatment for consecutive screenshot/view operations. The grouping and stable
image-to-action mapping need to land before broadening the gallery candidate
collector; scraping tool-result rows directly into the existing text-image
gallery would make ordering and disclosure behavior accidental.

The original image links remain at their original positions in the turn text.
Activating an image link opens that image directly in the full-screen viewer
with the complete turn gallery as navigation context. It does not change the
inline gallery's open or closed state. The gallery has one shared featured-item
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

Selecting a thumbnail also opens the full-screen image viewer at that image.
Navigation between the turn text and gallery therefore remains distinct from
full-size inspection.

The shared image viewer uses the useful viewport rather than the generic modal
preview ceiling. Selecting a thumbnail enters one maximized viewer state.
Activating the modal **×** or visible **Close** control, or pressing Escape,
returns to the prior transcript/gallery state. Clicking or tapping the image
stage never dismisses the viewer. Toolbar controls remain operable without
dismissing it. When a turn gallery supplies context, previous/next buttons and
the Left/Right arrow keys move through eligible images in original transcript
order and wrap at either end. The viewer shows the source-order position in
reserved space outside the image stage, even when compact packing visually
reorders the thumbnails.

The previous/next buttons and position are transient viewer chrome. They appear
briefly when the viewer opens. Fine-pointer movement over the image stage shows
both, and inactivity hides them so they do not obscure the image. Keyboard
Left/Right navigation reveals only the position; keyboard focus within the
previous/next controls keeps the full chrome visible. On touch screens, a tap
on the unzoomed or stationary image stage reveals the full chrome briefly
instead of closing the viewer. Touch movement used for pan or pinch does not
count as a tap.

The full-screen modal shell remains mounted and maximized throughout image
loading, decoding, navigation, and load failures; its geometry does not depend
on whether the image viewer child is currently ready. During gallery
navigation, the last decoded image, linked filename, and source-order position
remain visible until the requested replacement has decoded, then change
together. A superseded load must never replace a newer selection. If a
replacement fails, the current image stays visible with the error reported
over it rather than exposing or reflowing the transcript behind the modal.

Fit, 1:1, and stepped zoom are explicit inspection controls within that one
state, not further expansion levels. A 1:1 or otherwise zoomed image remains
scrollable and pannable instead of being clipped; trackpad pinch/wheel zoom
remains anchored near the pointer.

On touch screens, the gallery row retains its horizontal swipe behavior until
an image is selected. The selected image then owns a full-screen stage with
two-finger pinch zoom and one-finger pan, while closing it returns to the same
transcript/gallery position. The transient previous/next buttons remain
practical touch targets; tapping the stage reveals them and full-screen
horizontal swipe navigation is not required.

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
  upscale an image merely to align it with its row or fill the gallery. The
  phone swipe presentation retains the same natural width and height ceilings;
  its target card width is not permission to enlarge a small image. A vector
  has no natural pixel height for this cap to read; see *Vector sources have no
  suggested size* below.
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

The gallery footer has a turn-level **Collapse gallery** action with an Escape
keyboard accelerator. The `−` beside every eligible source link and the
persistent **− Gallery** action collapse the same turn-level state. Collapsing
removes the reordered gallery and reinstates each image as the existing minimal
link and `+` affordance at that image reference's original inline position.
The generic action returns to **+ Gallery**. The transcript's original
text/image-reference order is therefore always recoverable even though gallery
packing may reorder thumbnails. Activating a specific `+` restores the same
deterministic gallery arrangement centered on that image; activating
**+ Gallery** restores it at the last featured image. There is no second
“collapse to expanded inline images” state.

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

## Vector sources have no suggested size

Every sizing rule above assumes a raster: its pixel dimensions *are* its
suggested size, which is why a thumbnail never exceeds its natural height and
why the full-screen **Fit** shrinks but never enlarges. A vector has no pixel
grid, so those rules need an explicit vector case rather than an implicit
raster one.

An SVG carries a suggested size only when its root element declares absolute
`width` and `height`. A `viewBox` alone is an aspect ratio and nothing else —
and `width="100%"` defers to the container exactly like declaring nothing.
Both figure shapes are common: matplotlib's `savefig(...)` emits declared
point sizes, while mermaid, D3, and hand-authored figures routinely ship
viewBox-only.

The contract:

- **A declared size is honored.** A sized vector draws inline at its declared
  size, the same as a raster of those dimensions, and **Actual size** in the
  viewer means 1:1 against it. This is the only size channel: a Markdown image
  link carries no dimensions, and non-CommonMark extensions (`=600x400`,
  `?width=`) would break the same document read on GitHub or through pandoc.
- **An undeclared size is supplied by the container.** An unsized vector needs
  a definite width to resolve its ratio against; without one it collapses to
  zero and reads as a missing figure. Inline previews give it a bounded box
  (currently `min(100%, 640px)`) and let the ratio set the height. Sized
  vectors keep the ordinary shrink-to-fit frame so their declared size still
  decides.
- **Fit may enlarge a vector.** Filling the stage costs a vector nothing,
  whereas upscaling a raster shows interpolation rather than detail. The
  reported zoom percentage is relative to the declared size, or to the
  browser's ratio-derived default when there is none.

The failure mode is worth naming because it is invisible: a shrink-to-fit
ancestor gives an unsized vector an indefinite width, so the figure renders at
zero and the page looks like it simply has no image there. A `<button>` counts
as one — it sizes to its content even when set to `display: block` — so the
definite width has to be restated on the copy button that wraps the inline
preview, not only on the frame.

Sizing is all this section changes. Vectors continue to display through an
`<img>` fed by a relay-safe object URL, which is inert; nothing here permits
rendering an SVG as a top-level document or inlining its markup into the DOM.
See [active-content-security](active-content-security.md) — an SVG remains an
active document by that contract even where this one calls it an image.

Implemented in `lib/vectorImageSizing.ts` (classification),
`LocalMediaModal.module.css` (inline frame), and `ImageViewer.tsx` +
`ImageViewer.module.css` (viewer fit).

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

### Windows Markdown destinations

Agent-authored Markdown may use native drive paths such as
`D:\repo\.artifacts\capture.png`. CommonMark treats a backslash before
punctuation as an escape, so the Markdown lexer would otherwise turn
`repo\.artifacts` into the nonexistent `repo.artifacts` before YA can classify
the path.

The server Markdown boundary repairs this deterministically from the raw link,
image, or reference-definition token before rendering: any absolute
drive-letter destination (`A:` through `Z:`, case-insensitive) containing
backslashes is canonicalized to forward slashes. The original transcript text
is not rewritten. Code spans, code blocks, relative paths, URLs, and UNC paths
are not changed, and the resulting path still passes through the normal
project/file-access allow-set without fallback lookup or filesystem guessing.

## Known sharp edges

- **Bare API URLs in relay mode** — the canonical failure. Fixed in the
  `FileViewer` by giving the default source a `fetchRawFileBlob`; watch for it
  in any new surface.
- **In-project vs. out-of-project routing** — tool-result links always use the
  project files route; rendered-text links split by location. The two systems
  don't share the in/out-of-project decision. Their client action vocabulary
  now matches, but discovering that an outside path belongs to another scanned
  project remains a server-backed follow-up.
- **Stable viewer links for allow-listed local files** — the client does not
  call a raw `/api/local-file` URL a Viewer link. A real standalone viewer for
  those files requires a durable server/client coordinate that works across
  direct and relay connections.
- **Static preview assets** — the scriptless HTML preview denies ambient
  network loads. Supporting relative images or styles requires the trusted
  viewer to fetch, bound, and broker those assets; relaxing iframe networking
  is not the fallback.
- **Both doors share one allow-set** — as of `docs/tactical/018`, the
  project-files route enforces the same file-access allow-set as the media
  doors for absolute/`~` paths (relative paths stay project-scoped). The set is
  secure-by-default, so absolute paths outside projects/uploads/temp are denied
  until the user adds the folder (Settings → File access) or sets
  `ALLOWED_FILE_PATHS`.
- **Context-specific media remains** — normalized tool-result images share one
  media row, and modal-based local images share `LocalMediaModal`; attachments,
  rendered Markdown placeholders, and the project `FileViewer` retain
  context-specific presentation. Image actions now converge through one
  capability-shaped client menu and shared clipboard/download operations.
  Further cross-surface byte reuse still belongs in a shared source adapter or
  the narrowest common rendering boundary.
- **Opaque media viewer links** — the authenticated session-media fetch route
  serves bytes, not a stable YA application viewer. Copying that raw route or
  a transient object URL as **Viewer link** would misstate its lifetime and
  relay behavior. A durable session-media viewer coordinate remains
  server-backed work.
- **Repeated client fetches** — an expanded preview, later modal, download, or
  copy action can independently fetch the same media. The full viewer reuses
  its already-loaded blob for its own actions, but cross-surface blob sharing
  is not yet a bounded client cache. Add one only with explicit lifetime,
  byte-budget, object-URL revocation, and source-runtime scoping.
