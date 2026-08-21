# Active Content Origin Isolation

Status: active-response containment and its response-header backstop completed
2026-08-21. Broader viewer convergence, asset brokering, and the isolated
executable-application origin remain incomplete; this ledger does not by itself
authorize those later product changes.

Topic: active-content-security

Contract:
[`topics/active-content-security.md`](../../topics/active-content-security.md).
Reproduction and source audit:
[`topics/active-content-security.evidence.md`](../../topics/active-content-security.evidence.md).

## Objective

Contain current active-file responses, converge file actions on the safe
viewer, and establish real origin isolation before any project- or
agent-authored application is allowed to execute. The work must preserve
source inspection and explicit download while preventing browser-side
privilege gain in direct, desktop, hosted-relay, and public-share contexts.

## Product feature constraints

### Interactives: served pages

The proposed primary `page` class is a committed HTML+JS bundle. Serving it
directly from a project path on YA's authenticated origin is incompatible with
the contract. The class remains viable only as an isolated-origin app or a
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

The generated standalone Markdown document is the awkward exception. It
should converge on the unified SPA viewer. If retained for browser-native
copy/save or line navigation, its YA-owned script must be hash/nonce authorized
by a strict response CSP and all Markdown-derived DOM must stay sanitized.

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

## Remediation plan

### 1 — contain current active-file responses

Classify active types centrally and make every current local, project, upload,
and public-share raw response inert under native navigation. Apply the policy
server-side so old clients and copied links are protected immediately. Include
HTML and SVG regression fixtures.

**Completed 2026-08-21.** A shared MIME/extension classifier forces active
responses to download with `nosniff`, a scriptless sandbox CSP, no-referrer,
and a restrictive permissions policy. It performs no content scan or
sanitization and is cheap enough to run in every mode.

### 2 — converge file actions on the unified viewer

Make normal, modified, context-menu, tooltip/copied-link, and toolbar actions
resolve to the standalone viewer route. Reserve raw original bytes for an
explicit download or a viewer-owned authenticated fetch.

**Partially completed 2026-08-09.** Current shared-viewer actions keep HTML in
source or explicit scriptless preview. A stable standalone viewer coordinate
for arbitrary allow-listed local files remains open.

### 3 — harden scriptless previews

Add response-header CSP/defense headers where a document response remains,
keep HTML preview sandboxed without script tokens, broker local assets, and
verify that no iframe action can escape to a raw active URL.

**Response backstop completed 2026-08-21.** Active raw responses carry the
header CSP even if attachment handling is bypassed. Relative-asset brokering
and the remaining iframe escape matrix are still open.

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

## Verification matrix

Current containment evidence covers route-level malicious HTML/SVG/XML cases
for local, project, upload, and public-share responses, plus a real Chromium
click test for project HTML, project SVG, and the reproduced `/api/local-file`
HTML route. The full server suite also passes. This proves the shared response
invariant and direct browser download behavior, not every transport and action
combination below.

The broader remediation is incomplete until browser tests exercise:

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
