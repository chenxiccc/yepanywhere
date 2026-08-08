# Server-Side Rendering for Mobile Performance

> **Current implementation (2026-08-08):** This document began as the design
> proposal. YA now carries reviewed presentation fields inline on message
> blocks, uses WebSocket session events for live delivery, and emits raw provider
> messages before optional finalization. The durable and live paths share the
> finalized-message augmenter. See
> [`stream-persisted-render-parity.md`](../../topics/stream-persisted-render-parity.md)
> for the ordering and convergence contract.

## Problem

The mobile client has performance issues that degrade the user experience:

1. **Streaming doesn't stream**: `react-markdown` parses the entire text on every chunk, which is slow enough on mobile that React batches all updates until streaming completes.

2. **Large client bundle**: Libraries like `react-syntax-highlighter` (Prism-based) and `react-markdown` add significant bundle size.

3. **Inconsistent diff display**: Pending edits show verbose "all removed, then all added" format, while completed edits show compact unified diffs with context lines (because the SDK computes `structuredPatch` for results but not for pending tool_use).

4. **Highlighting limitations**: Client-side Prism has a 1000-line limit to avoid blocking the main thread.

## Goal

Offload expensive computation to the server so the mobile client:
- Receives pre-rendered, ready-to-display content
- Has minimal JavaScript bundle
- Maintains responsive UI during streaming
- Shows consistent, high-quality rendering

## Solution: Server-Side Augments

The server will compute "augments" - pre-rendered presentation data - and send them alongside SDK messages. SDK message types stay unchanged; augments are a separate data channel.

### Security boundary

Augment HTML is a sanitized fragment produced by a reviewed YA renderer and
inserted into an existing trusted client document. It is never arbitrary
provider/project HTML and never a standalone active document. The fragment
renderer must reject executable elements, event handlers, unsafe URLs, and
active embeds before any `dangerouslySetInnerHTML` use. See
[`active-content-security.md`](../../topics/active-content-security.md) for the
separate source/download and isolated-origin rules governing HTML files,
scripted SVG, and executable applications.

### Augment Types

| Content Type | Augment Data |
|--------------|--------------|
| Edit tool_use (pending) | `structuredPatch`, highlighted diff HTML |
| Edit tool_result | Highlighted diff HTML |
| Read tool_result | Highlighted file content HTML |
| Text blocks | Rendered markdown HTML |

### Libraries (Server-Side)

- **diff** (jsdiff): Compute `structuredPatch` for pending edits
- **shiki**: Syntax highlighting with TextMate grammars (VS Code quality)
- **markdown-it**: Markdown rendering with source-line token maps

### Data Flow

#### Live session stream (WebSocket)

The session subscription sends each raw provider message immediately, before
optional presentation work. Identified finalized messages may then receive one
same-id enriched replacement. A final `markdown-augment` event follows for
compatibility with older clients; current clients prefer inline block HTML and
reduce the compatibility event to an idempotent update.

```text
WebSocket: message(raw provider item)
WebSocket: message(same id, all finalized presentation fields)
WebSocket: markdown-augment(equivalent final Markdown, compatibility)
```

Mutable incremental-Markdown coordinator state stays on one FIFO lane. Finalized
items use bounded independent work, so slow highlighting for one item cannot
hide or reorder another raw provider record.

#### Persisted Sessions (REST)

The REST response carries the same presentation fields inline on detached
message blocks. For example, text blocks carry `_html`; Edit inputs carry
`_structuredPatch`, `_rawPatch`, and `_diffHtml`; Read/Write/plan results carry
their renderer-specific fields. There is no separate persisted augment map.

```json
{
  "session": { "id": "..." },
  "messages": [
    {
      "uuid": "assistant-1",
      "message": {
        "content": [
          { "type": "text", "text": "Hello", "_html": "<p>Hello</p>" }
        ]
      }
    }
  ]
}
```

### Client Changes

1. **Consume inline presentation fields** through the canonical transcript
   compiler and tool renderers.
2. **Render reviewed HTML directly** with the sanitization boundary above.
3. **Retain final Markdown compatibility state** in the session-detail reducer,
   keyed by stable message ID and preserved through warm route snapshots.
4. **Keep token-rate pending Markdown outside React state** on the ref-backed
   streaming path.
5. **Fall back to raw content** when optional presentation work is absent or
   fails.

### Server Changes

1. **Canonical finalized-message augmenter** computes diffs, previews, syntax
   highlighting, and Markdown for both live and persisted paths.
2. **Session subscriptions** send raw provider activity first, then bounded
   same-id finalized replacements without delaying completion.
3. **Session reads** augment detached file-backed or active-process messages.
4. **Provider persistence remains authoritative**; YA does not cache a shadow
   transcript to retain live presentation shape.

## Implementation Phases

These headings preserve the original delivery sequence. The core phases are
implemented; current behavior is described in **Data Flow** above.

### Phase 1: Edit Tool Diffs

- Add `diff` and `shiki` to server
- Create augment service with `computeEditAugment()`
- Wire into `stream.ts` for live sessions
- Wire into `sessions.ts` for persisted sessions
- Update `EditRenderer.tsx` to consume augments
- Consistent unified diff display for pending and completed edits

### Phase 2: File Viewer (Read Tool)

- Add `computeReadAugment()` to augment service
- Update `ReadRenderer.tsx` and `FileViewer.tsx`
- Remove 1000-line highlighting limit

### Phase 3: Markdown Rendering

- Add markdown-it renderer to augment service
- Handle streaming: render complete paragraphs/blocks, buffer incomplete ones
- Update `TextBlock.tsx` to render pre-rendered HTML
- Support file path detection server-side

### Phase 4: Cleanup

- Remove `react-syntax-highlighter` from client
- Remove `react-markdown` from client
- Remove `diff` from client
- Measure bundle size reduction

## Open Questions

1. **Shiki theme output**: Should server output themed HTML (with colors), or semantic classes that client CSS themes? Semantic classes are more flexible for light/dark mode.

2. **Markdown streaming**: How to handle incomplete markdown during streaming? Options:
   - Buffer until complete block, then render
   - Send raw text for current block, re-send rendered when complete
   - Render incrementally with fixups

3. **Augment caching**: Should we cache augments to disk for persisted sessions? Pros: faster subsequent loads. Cons: cache invalidation, storage.

4. **Language detection**: When file extension is unknown, how to detect language for highlighting? Shiki doesn't auto-detect. Options: heuristics, fall back to plain text.

5. **Partial file highlighting**: For diff hunks without full file context, will Shiki handle multi-line constructs (strings, comments) correctly? The context lines in `structuredPatch` should help, but edge cases may exist.

6. **Error handling**: If augment computation fails, what to show? Probably fall back to plain text with no highlighting.

## Testing Strategy

This architecture is highly testable:

- **Unit tests**: Augment service functions (diff computation, highlighting) in isolation
- **Integration tests**: End-to-end augment flow through SSE and REST endpoints
- **Snapshot tests**: Verify highlighted output doesn't regress
- **Performance tests**: Measure augment computation time, ensure it doesn't delay message delivery

## Success Metrics

- Streaming text actually streams on mobile (visual updates during stream)
- Client bundle size reduced by ~200-300KB (react-markdown, react-syntax-highlighter, Prism)
- Consistent diff display between pending and completed edits
- File viewer can handle files >1000 lines with highlighting
