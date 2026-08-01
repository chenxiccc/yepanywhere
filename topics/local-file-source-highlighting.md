# Local-File Source Highlighting

> Proposal for syntax-highlighted previews of common source-file extensions
> rendered through the shared source viewer without creating another
> main-origin standalone HTML document.

Topic: local-file-source-highlighting

Status: **proposal, revised for active-content isolation (2026-08-01).** See
[`active-content-security.md`](active-content-security.md).

## Proposal

`/api/local-file` should eventually offer a lightweight highlighted preview for
common source and config files by reusing the server's existing Shiki
highlighting service. YA already uses Shiki for FileViewer, Read, Write, and Edit
augments, so this should not add a new dependency or a second highlighter.

The feature should be an additive preview mode. Unknown non-media extensions can
continue to serve as `text/plain; charset=utf-8`; recognized Shiki extensions
should return a sanitized highlighted fragment through a viewer/data response
and render it inside the shared `FileViewer`. They must not serve a new
standalone `text/html` document from `/api/local-file` merely to obtain browser
presentation.

## Constraints

- Do not weaken the local-resource path policy. Highlighting changes only
  presentation after the route has accepted the path.
- Keep raw Markdown available. The existing `render=1` standalone Markdown
  document is transitional rather than precedent; highlighted source should
  converge on the shared viewer, and the Markdown route must independently
  satisfy the active-content response contract while it remains.
- Keep media extensions on the media route. `/api/local-file` should not become
  an image/video preview endpoint.
- Cap highlighted file size or line count using the existing highlighter limits
  so direct browser gestures cannot make a large source file expensive to open.

## Candidate Shape

Add a viewer-facing request shape for local-file source previews that returns
the raw source plus an optional sanitized Shiki fragment, analogous to the
project `FileViewer` data contract. If Shiki returns no language for the path,
fall back to the current plain-text response. Markdown preview may continue to
take presentation precedence, but native navigation must still land on the
viewer rather than an active raw response.
