# Active Content Serving and Origin Isolation

> Agent- or project-authored active content must never execute with YA's
> authenticated server origin or hosted-client origin. File viewing is
> source-first and scriptless; applications that intentionally execute need a
> separate untrusted-content origin with no YA credentials or ambient API
> authority.

Topic: active-content-security

Status: **open security defect and product constraint (2026-08-01).** A
same-origin HTML execution path was reproduced against `/api/local-file`; the
route and adjacent active-content surfaces have not yet been remediated. This
document records the vulnerability, the required behavior, and the product
plans that must change before implementation.

See also:

- [security](security.md) — the broader authenticated, relay, and public-share
  trust boundaries.
- [media-rendering-and-routing](media-rendering-and-routing.md) — the shared
  file/media viewer and transport rules.
- [interactives](interactives.md) — the proposal most directly constrained by
  executable-content isolation.
- [session-sandboxing](session-sandboxing.md) — why a confined provider must
  not be able to borrow the operator browser's authority through a file it
  writes.
- [rich-text-rendering](rich-text-rendering.md) — sanitized HTML fragments are
  a different trust class from standalone active documents.

## Recorded Vulnerability

On 2026-08-01 an agent-created local HTML file was opened from YA. The normal
in-app viewer placed the file in a sandboxed iframe and did not run its script.
The viewer's open-in-new-tab path navigated to:

```text
/api/local-file?path=<absolute-agent-written-file.html>
```

That response used `Content-Type: text/html` and
`Content-Disposition: inline`, with no response CSP. The browser parsed it as a
top-level document on the authenticated YA origin. Its inline script fetched:

```text
GET /api/processes?includeTerminated=true
```

The request succeeded and the document displayed the running agent processes.
The demonstrated operation was read-only, but the acquired authority is not:
a same-origin script can call authenticated YA APIs, and it can supply the
`X-Yep-Anywhere: true` header required by mutating routes.

This is a browser-assisted sandbox escape/confused-deputy path:

```text
sandboxed or untrusted agent
  -> writes active project/local content
  -> operator follows an ordinary-looking file/viewer action
  -> browser executes the content on a more privileged YA origin
  -> content acts with the operator browser's YA authority
```

The user gesture lowers exploitability but does not restore the boundary. The
agent controls both the file and much of the prose/link context encouraging the
gesture. A sandboxed agent is specifically a case where its project writes
must remain data after the operator inspects them.

## Why Existing Protections Do Not Contain It

- The `yep-anywhere-session` cookie is `HttpOnly`, but that only prevents
  reading the cookie value. Same-origin requests automatically use it.
- `SameSite=Lax` is irrelevant to a document executing on the same origin.
- The custom mutation header is a cross-origin/form defense. Same-origin
  JavaScript can set it.
- CORS and Origin checks do not constrain same-origin JavaScript.
- The production app and hosted remote entry documents carry CSP, but CSP is
  enforced per response/document. Their policies do not transfer to a newly
  opened `/api/local-file` or project raw-file response.
- Removing inline `<script>` elements is not a security boundary. External
  scripts, event attributes, scripted SVG, forms, frames, navigation, workers,
  and future active formats would remain.
- `X-Content-Type-Options: nosniff` prevents type guessing; it does not make an
  explicitly declared `text/html` or `image/svg+xml` response inert.

The agent's usual host access is also not a reason to accept the behavior. YA
supports restricted providers and future delegated/untrusted work. Even an
otherwise privileged agent should not silently acquire browser-local resume
material, public-share bearer data, or UI authority merely because a user
inspected its output.

## Content Trust Classes

The implementation and future designs must keep four classes separate.

### Trusted YA application documents

YA-owned entry documents, scripts, service workers, and narrowly scoped
diagnostic pages are application code. They may execute on a YA origin only
when they are shipped as reviewed build inputs and carry the intended
production CSP. Project files, uploaded files, provider output, plugin output,
and agent-created files never become trusted merely because a YA route serves
them.

### Sanitized rich-text fragments

Server-rendered Markdown, syntax highlighting, diffs, and declared rich-input
forms may be inserted into an existing trusted YA document as inert fragments.
Their renderer/sanitizer must reject executable elements, event handlers,
unsafe URL schemes, active embeds, and other DOM authority. This class does not
need a separate origin, but it must never accept arbitrary HTML as a shortcut.

`dangerouslySetInnerHTML` describes a React insertion mechanism, not a trust
decision. Only output from the owning reviewed renderer/sanitizer belongs in
this class.

### Untrusted active documents

HTML, XHTML, SVG, and other browser-active formats supplied by a project,
agent, upload, or share are data to YA's normal file-viewing surfaces. They are
shown as source, downloaded, or rendered in a scriptless opaque sandbox. They
must not execute as top-level documents on a YA origin.

Initial active-type classification must include at least:

- `text/html` and `.html` / `.htm`;
- `application/xhtml+xml` and `.xhtml` when accepted;
- `image/svg+xml` and `.svg`; and
- XML/XSLT-capable responses until their browser behavior and type policy are
  deliberately narrowed.

Classification must use the final response type plus conservative extension
and content checks. A caller-provided MIME type is not trustworthy. PDF and
other document formats need an explicit browser-capability review; absence
from the initial confirmed list is not a declaration that they are inert.

### Untrusted executable applications

An Interactive or another deliberately runnable agent-built app is allowed to
execute only inside an isolated application environment. It is not a richer
file preview and cannot use the authenticated YA or hosted-client origin.

## Current Surface Audit

This is a source audit as of 2026-08-01. "Potential" means the response shape
is active and must be treated as unsafe even when that exact browser path was
not used in the reproduction.

| Surface | Current behavior | Assessment and required direction |
|---|---|---|
| `/api/local-file` HTML | Rewrites local references, returns `text/html` inline with `nosniff`, and has no response CSP. | **Confirmed vulnerable.** Normal navigation must become source/viewer navigation or download. |
| `/api/local-file?render=1` Markdown | Returns a YA-generated standalone HTML document containing sanitized rendered Markdown and YA-owned inline behavior. | Transitional trusted-shell surface. Prefer the shared SPA viewer; if retained, give the response a strict hash/nonce CSP and keep all document input sanitized. It is not a primitive for arbitrary HTML. |
| `/api/projects/:id/files/raw` | Maps `.html` to `text/html`, `.svg` to `image/svg+xml`, and XML to an XML type; defaults to inline unless `download=true`. | **Potential active-content execution.** Active types must not be inline-native navigation targets. |
| `/api/local-image` | Serves allow-listed SVG as `image/svg+xml` without CSP or attachment disposition. | **Potential scripted-SVG execution.** Inline `<img>` use can remain blob-mediated after SVG sanitization or rasterization; top-level/raw SVG navigation must be blocked or downloaded. |
| Session upload GET | Serves uploaded SVG as `image/svg+xml` without CSP or attachment disposition. HTML currently falls back to octet-stream. | **Potential scripted-SVG execution.** Apply the same active-type response policy as local/project files. |
| Tool-result media | Validates and materializes only PNG, GIF, JPEG, and WebP before serving. | Not currently an active-document source. Preserve the byte-signature validation; do not add SVG/HTML without this review. |
| Public-share raw files | Proxies the project raw-file response and most of its headers. | Inherits active-type behavior. Bearer-link scoping limits which file is read, not what executing it can do to the serving/hosted origin. |
| `LocalFileModal` HTML | Fetches bytes and, in direct mode, uses `<iframe sandbox="" srcDoc=...>`; relay mode shows source. | The reproduced script did not run here. Keep the no-token sandbox as the scriptless preview baseline and remove escapes to raw active responses. |
| Shared `FileViewer` | Presents source/Markdown preview and normally uses SPA routes/object URLs. | Correct unification point. Every active-file open/new-tab action should land here or download, never at a raw active response. |
| Main/remote client entry documents | Production Vite output injects a hash-based CSP; server-served app HTML also receives an app CSP. | Trusted YA code only. These policies do not protect API documents. Audit auxiliary public HTML separately because not every copied file passes through the Vite HTML transform. |

An implementation pass must re-run this inventory rather than assuming the
list is complete. Any generic byte-serving route, attachment route, share
proxy, plugin asset route, or future app proxy is in scope.

## Observable Safety Contract

The following behavior is required across direct, desktop-loopback, hosted
relay, and public-share contexts.

1. An ordinary click, modified click, context-menu open, viewer toolbar action,
   copied viewer URL, browser restore, or redirect must never turn an untrusted
   active file into a top-level document on a YA application origin.
2. The normal action for an active file opens the unified viewer in source
   mode. An explicit static preview may use a sandbox with scripts disabled.
3. "Open in new tab" means the standalone YA viewer route, not the raw-file
   endpoint. "Download" is the action that returns original active bytes.
4. Raw active responses use attachment disposition, an inert type such as
   `text/plain` where source display is intended, and `nosniff`. A raw-byte API
   needed by the viewer must not itself be a safe native-navigation target.
5. Client interception is convenience, not containment. Server responses are
   safe when reached by an old client, a copied link, direct address-bar
   navigation, or a non-browser HTTP caller.
6. Scriptless HTML preview does not load network resources, submit forms,
   create workers, open popups, navigate the top level, or access YA APIs.
7. SVG follows the active-document policy even when the UI calls it an image.
   If inline SVG display is required, sanitize/rasterize it or render it under
   equivalent isolation; object URLs alone are not an execution boundary.
8. Public-share and hosted-client routes preserve the same active-type policy.
   A missing local `/api` backend does not make executing content safe because
   the hosted origin can hold browser-local login/resume state.

## Response CSP Is a Backstop, Not the Primary Boundary

CSP belongs in HTTP response headers on the response being protected. YA does
not need to inject a `<meta>` element into an untrusted file. A scriptless
static preview policy can begin from:

```http
Content-Security-Policy: sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The exact asset allowances belong to the preview design. Local/project assets
should be fetched by the trusted viewer and brokered as bounded blob/data
resources rather than reopening authenticated network access inside the
document. Add a restrictive `Permissions-Policy` where browser support makes
it useful.

For source-only responses, `text/plain` or attachment handling is simpler and
stronger; CSP remains defense in depth. For applications that intentionally
run scripts, `script-src` changes cannot create a trust boundary on a shared
origin. Those applications require origin isolation.

## Executable Application Origin Contract

Any feature that runs project- or agent-authored JavaScript must satisfy all of
these constraints before it ships:

- **No shared YA origin.** A path such as `/apps/:project/:name/*` on the main
  server or `ya.graehl.org/apps/...` is not isolation. A different port is an
  origin boundary for DOM access but cookies are not port-scoped, so it is not
  the preferred credential boundary either. Use a different host at minimum;
  a dedicated registrable user-content domain is stronger.
- **No YA credentials.** The application host does not receive or accept the
  YA session cookie, Authorization headers, relay resume secrets, public-share
  secrets, or browser-local YA storage. YA auth cookies remain host-only and
  must never acquire a parent-domain scope that includes user content.
- **No YA API namespace.** `/api`, `/public-api`, WebSocket control channels,
  and native/desktop bridges are absent or fail closed on the application
  host. YA does not grant credentialed CORS to it. Mutations remain
  non-GET and require the custom header as defense in depth.
- **Scoped entry capability.** If access control is needed, use a short-lived
  or revocable capability accepted only by the one interactive/asset broker.
  Disclosure by the running app must not grant session, project, or general YA
  API access.
- **Sandboxed embedding.** Default embedding uses an opaque-origin iframe with
  `allow-scripts` only when execution is intended and without
  `allow-same-origin`. A dedicated untrusted origin may later receive narrowly
  justified sandbox tokens for storage/workers; it never gains YA origin.
- **Brokered host communication.** `postMessage` is schema-validated,
  capability-scoped, and tied to the expected child window. With an opaque
  origin, `event.origin` is `"null"`, so the parent must verify `event.source`
  and never send ambient secrets through a wildcard channel.
- **Safe top-level opens.** A script-enabled new-tab view exists only on the
  isolated application host and is opened with `noopener`. A blob URL or
  `srcdoc` created by the trusted client is not used as an unsandboxed
  top-level substitute.
- **Worker containment.** Untrusted applications cannot register a service
  worker on a YA or hosted-client origin. Any worker scope remains entirely on
  the isolated application host and is cleaned up/revoked with that app's
  lifecycle where feasible.

One common application origin isolates apps from YA but not from one another.
If applications may hold mutually sensitive state, the design must add
per-app origins or another storage/process boundary.

### Direct and relay delivery

Direct delivery needs a distinct application host/virtual host whose handler
serves or proxies app assets but exposes no YA control routes. A proxy must
strip YA cookies, Authorization, forwarding headers that carry identity, and
other ambient credentials before contacting the loopback app.

Hosted relay delivery cannot place agent content at a path on the hosted YA
client origin. It needs either:

- a dedicated untrusted-content host reachable through a scoped relay/broker;
  or
- a trusted client that fetches the bundle over the encrypted connection and
  constructs a strictly sandboxed opaque-origin iframe with a complete asset
  broker.

The second option is suitable for controlled static bundles but does not
automatically support arbitrary navigation, workers, storage, WebSockets, or
multi-file apps. Optional Tailscale and Cloudflare transport changes
reachability, not this isolation requirement.

## Planned Product Feature Audit

### Interactives: served pages

The proposed primary `page` class is a committed HTML+JS bundle. Serving it
directly from a project path on YA's authenticated origin is incompatible with
this contract. The class remains viable only as an isolated-origin app or a
complete bundle loaded into an opaque sandbox. Its "always live" property can
remain; its main-origin serving assumption cannot.

### Interactives: proxied apps

The proposed `/apps/:projectId/:name/*` main-server proxy is also incompatible
as a browser-visible origin. Authentication may authorize the trusted YA UI to
mint/open a scoped app capability, but the app's bytes and WebSocket must be
presented through the isolated application host. The proxy must strip YA
authority before forwarding to the loopback app.

The side-by-side embedded workspace remains compatible. The app pane is the
sandboxed cross-origin child and the session pane remains trusted YA UI. A
secondary new-tab app view requires a real isolated URL; it cannot fall back to
a raw main-origin route.

### Interactives: meta-UI channel and transport options

The proposed brokered comment-to-agent `postMessage` channel is compatible and
becomes the required capability pattern. It should land comments in the
composer for user confirmation, without exposing general API fetch.

Tailscale, Cloudflare Tunnel, and the encrypted relay may deliver the isolated
app host, but a tunnel to the main authenticated proxy path is not sufficient.
Hostname/virtual-host routing and scoped app admission must preserve the split
at every transport.

### Rich interviews

The banked declarative-form plan remains compatible because YA renders a
reviewed schema with YA-owned components. It must continue to reject arbitrary
HTML/JS. Its stated arbitrary-DOM escape hatch inherits the Interactives
isolation contract rather than embedding arbitrary DOM in the YA document.

### Server-rendered Markdown, diffs, and highlighting

The server-side augment and rich-text plans remain compatible as sanitized
fragments in trusted YA components. They do not justify serving provider HTML
as standalone documents, and they must not expand their input contract to
arbitrary HTML. A sanitizer regression here is script injection into the
trusted app and therefore remains security-critical even with a strict app
CSP.

The generated standalone Markdown document is the awkward exception. It should
converge on the unified SPA viewer. If retained for browser-native copy/save or
line navigation, its YA-owned script must be hash/nonce authorized by a strict
response CSP and all Markdown-derived DOM must stay sanitized.

The proposed local-file source-highlighting feature previously suggested more
small standalone HTML documents. That shape is rejected: highlighting remains
viable as a sanitized fragment rendered by the unified viewer, not as a new
browser-executable local-file response.

### Public-share and unified file viewers

The unified viewer is the correct shared presentation for authenticated and
public-share file reads. Share scoping decides whether bytes may be fetched;
the active-content policy decides how those permitted bytes may be displayed.
Public-share raw routes must not proxy an unsafe inline media type merely
because the file was legitimately in the share manifest.

### Server plugins and future UI extensions

The banked server-plugin document points to out-of-process Interactives as the
preferred extensibility model. That remains preferable to loading foreign code
inside YA, but only with the isolated-origin proxy design. "Out of process" is
not browser-origin isolation by itself.

### Hosted client deployment

Moving the trusted hosted client away from GitHub Pages is not a prerequisite
for fixing `/api/local-file`: the vulnerable response comes from each YA
server, and the production hosted entry already receives a hash-based CSP meta
policy at build time.

A header-capable static host is still useful hardening for the trusted client:
it can apply header-only directives, consistent policies to auxiliary HTML,
permissions/referrer headers, and CSP reporting. It does not make a shared path
safe for agent content. Any hosted executable-content feature needs a distinct
untrusted-content host regardless of where the trusted client is deployed.

## Remediation Order

### 1 — contain current active-file responses

Classify active types centrally and make every current local, project, upload,
and public-share raw response inert under native navigation. Apply the policy
server-side so old clients and copied links are protected immediately. Include
HTML and SVG regression fixtures.

### 2 — converge file actions on the unified viewer

Make normal, modified, context-menu, tooltip/copied-link, and toolbar actions
resolve to the standalone viewer route. Reserve raw original bytes for an
explicit download or a viewer-owned authenticated fetch.

### 3 — harden scriptless previews

Add response-header CSP/defense headers where a document response remains,
keep HTML preview sandboxed without script tokens, broker local assets, and
verify that no iframe action can escape to a raw active URL.

### 4 — design the isolated Interactives host

Do not implement served pages or the `/apps/...` proxy until direct and relay
origin topology, scoped admission, cookie/header stripping, WebSocket routing,
new-tab behavior, worker scope, and the `postMessage` capability schema are
settled and threat-tested.

### 5 — inventory trusted hosted pages

Enumerate every production HTML entry and copied auxiliary page, record its
expected script hashes/sources, and decide whether to use a header-capable host
for uniform CSP and reporting. Keep this work distinct from untrusted-content
origin isolation.

## Verification Matrix

The remediation is incomplete until browser tests exercise:

- authenticated direct/LAN access;
- desktop loopback access;
- hosted encrypted-relay access;
- public-share file viewing;
- normal click, modified click, context menu, copied URL, toolbar open, reload,
  and browser restore;
- HTML with inline and external scripts, event handlers, forms, frames,
  workers, popups, and fetch attempts;
- SVG with script/event/network attempts;
- read and mutating YA API attempts, including an explicit
  `X-Yep-Anywhere: true` request;
- CSP, disposition, content type, `nosniff`, referrer, and permissions headers;
  and
- a sandboxed session writing the proof file, followed by operator inspection,
  with no browser-side privilege gain.

Success means the source remains inspectable and downloadable while every
active execution attempt is blocked or confined to an origin that has no YA
authority.

## Open Decisions

- The direct and hosted untrusted-content hostnames/registrable domains and how
  local development resolves them.
- Whether static HTML preview needs any network-loaded asset class, or all
  assets should be brokered blobs/data.
- Whether executable Interactives share one untrusted origin or receive
  per-app origins for storage isolation.
- The scoped app-admission token shape and revocation/lifetime policy.
- Which PDF and XML-family capabilities require attachment-only handling.
- Whether the standalone rendered-Markdown document has enough browser-native
  value to retain after unified-viewer convergence.
- Whether trusted hosted-client headers justify moving the primary static
  deployment; this is hardening, not the active-content fix.
