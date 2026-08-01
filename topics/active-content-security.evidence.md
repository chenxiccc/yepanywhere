# Active Content Security Evidence

> Reproduction notes and source observations supporting the active-content
> security contract. New evidence is appended; the product contract remains in
> [`active-content-security.md`](active-content-security.md).

Topic: active-content-security

## 2026-08-01 — confirmed same-origin local-file execution

An agent-created local HTML file was opened from YA. The normal in-app viewer
placed the file in a sandboxed iframe and did not run its script. The viewer's
open-in-new-tab path navigated to:

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

### Existing protections did not contain the reproduction

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

## 2026-08-01 — active-content surface audit

"Potential" means the response shape is active and must be treated as unsafe
even when that exact browser path was not used in the reproduction.

| Surface | Observed behavior | Assessment and required direction |
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
