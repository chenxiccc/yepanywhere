# Relay Head-of-Line Blocking

See also: [glossary tooltips](../../topics/glossary-tooltips.md).

## Status: Mitigated at independent-work boundaries

Investigated as a possible cause of intermittent "Request timeout" errors (~1 in 30-60 requests) via relay. The actual root cause turned out to be a nonce-byte heuristic bug in `isBinaryEncryptedEnvelope` — see commit `0f4f7a1`.

The per-connection queue still serializes decrypt/auth/decode and stateful frame admission. Work with its own identity and completion channel leaves that queue after admission: tunneled HTTP requests run independently by request id, and glossary subscription readiness runs behind a synchronously installed subscription-id cancellation generation. Upload framing and other stateful message sequences remain serialized.

This doc retains the original HOL analysis and records the boundaries that have since moved.

## Original Mechanism

At the time of the original investigation, both the Hono and raw WebSocket relay paths serialized all incoming messages through a single promise queue:

```typescript
// ws-relay.ts (both paths)
rawWs.on("message", (data, isBinary) => {
    messageQueue = messageQueue.then(() =>
        handleMessage(...)  // Each must COMPLETE before the next starts
    );
});
```

At that point, `routeMessage` also awaited complete HTTP request processing:

```typescript
case "request":
    await handleRequest(msg, send, app, baseUrl);  // blocks queue
```

`handleRequest` does `await app.fetch(...)` — the full Hono route handler round-trip. A slow request blocks all subsequent messages (requests, subscriptions, pings) in the queue.

That behavior affected **all tunneled connections** (both relay and direct encrypted), since both tunnel HTTP requests through the WebSocket. Direct unencrypted connections use regular HTTP and were unaffected.

## Why It Was Not the Observed Timeout

In practice, responses are fast — the observed timeouts were caused by the nonce heuristic silently dropping ~0.78% of encrypted messages, not by queue delays. If HOL blocking were the issue, you'd see increasing latency on later requests, not instant responses with occasional total drops.

## Implemented Independent-Work Boundaries

Tunneled requests now launch `handleRequest` without awaiting the route result in the frame queue:

```typescript
onRequest: async (requestMsg) => {
    // handleRequest always answers through the request's own id.
    void handleRequest(requestMsg, send, ws, app, baseUrl, connState);
}
```

### What Stays Serialized

The queue still orders admission for connection-scoped state:

- **subscribe/unsubscribe** — subscription-id admission remains ordered. Glossary subscription readiness is separate work after its cancellation generation is installed, so an unsubscribe can cancel it immediately.
- **upload_start/chunk/end** — offset validation requires ordering.
- **ping** — lightweight admission remains ordered, but no earlier independent request or glossary initialization can hold it behind route/filesystem completion.

### Risks and Caveats

- **No implicit request ordering**: A client with a mutation followed by a dependent read must await the mutation response. Independent request ids are completion channels, not a causal-order promise.
- **`send()` concurrency**: Responses may finish out of request order. `send()` encrypts each response with an independent random nonce and the WebSocket buffers writes; clients correlate results by request id.
- **Error attribution**: Concurrent failures still answer through their request ids, while logs need the same ids for correlation.
- **Stateful protocols stay admitted in order**: Upload offsets, transport sequencing, authentication, and subscription-id creation/removal do not inherit the independent-request rule.

## Recommendation

Keep the serialized admission queue rather than broadly parallelizing frame handling. When a new operation has its own identity, cancellation generation, and response channel, install those synchronously and move only its independent completion work outside the queue. Its regression should hold that work pending while a later lightweight frame and cancellation both proceed.

## Files

- `packages/server/src/routes/ws-relay.ts` — message queue setup (lines ~243, ~348)
- `packages/server/src/routes/ws-relay-handlers.ts` — `routeMessage`, `handleRequest`
- `packages/client/src/lib/connection/RelayProtocol.ts` — client-side 30s timeout
