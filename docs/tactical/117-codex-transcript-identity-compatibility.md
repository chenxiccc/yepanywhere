# Codex Transcript Identity Compatibility

Status: Implemented 2026-08-25

Topic: stream-durable-id-dedup

## Problem

The current client assumes that every Codex server aligns live stream message
ids with durable transcript ids. That is true for current source servers after
the exact Codex transcript identity work, but it is not true for supported
stable servers. A hosted client built from `main` can therefore merge a live
Codex transcript with an older server's durable backfill and render both copies
of user, assistant, or reasoning messages.

The exact-identity client behavior also changed replay suppression: current
Codex streams require a matching persisted id before discarding a replay,
whereas older servers require the previous timestamp-watermark fallback.

## Compatibility Decision

This is core session functionality. The reviewed stable-server corpus is
`v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0`; all lack the stream/durable Codex
identity contract.

Add permanent global capability `codex-stream-durable-id-alignment` with
numeric id 48. It is version-implied beginning in `0.7.2`; source-ahead builds
advertise its id through the existing version capability bitset. The
capability means that the server implements the Codex normalization and send
semantics needed for live and durable copies to share provider or client
identity when that identity exists.

No route, request field, response field, or event is added. The gate selects
the interpretation of existing `message.uuid` values in REST transcript rows
and streamed session messages.

When the capability is present, the client uses exact Codex identity:

- merge live and durable rows by shared message id;
- suppress replay only when its id is already durable;
- do not use general content/timestamp reconciliation or steer-text pairing.

When the capability is absent or version metadata has not loaded, the client
uses the former Codex compatibility path:

- reconcile opposite-source equal messages within the existing two-second
  window;
- exclude tool rows from general approximate reconciliation;
- reconcile legacy Codex steer echoes;
- suppress replays against the durable timestamp watermark.

The fallback makes no unsupported request and preserves the pre-exact-identity
tradeoff: an older server can rarely collapse genuinely distinct identical
rows, but it does not routinely double-render stream/backfill overlap. Keep
the fallback until a separate compatibility-floor review explicitly removes
it; the capability identity itself remains permanent.

Existing capability meanings, the coarse remote compatibility level, and
behavior for other providers remain unchanged.

## Implementation Plan

### 1 — register Codex transcript identity support

Allocate id 48 in the shared capability ledger, add the permanent
version-implied registry definition and exported constant, and include it in
the server's base capability set so source-ahead servers advertise it.

Cover id encoding, version implication, source-ahead advertisement, and the
server version response using the existing capability tests and audit.

### 2 — carry the connected server's identity mode into session detail

Derive the capability from the source-scoped version metadata already read by
`SessionPage`, and pass it through `useSession` and `useSessionMessages` to the
session-detail coordinator/reducer boundary. Default missing or pending version
metadata to the legacy mode.

Keep the mode source-scoped and explicit; do not mutate the static Codex
provider descriptor based on one connection.

### 3 — gate every Codex exact-identity reducer behavior

Use exact behavior only for capable servers. For incapable servers, restore
all three parts of the former behavior together: approximate non-tool
reconciliation, steer-echo reconciliation, and timestamp-watermark replay
suppression.

Do not change Codex native-tool or scoped code-mode reconciliation, Codex OSS,
Claude queue reconciliation, or other provider behavior.

### 4 — prove both sides of the compatibility boundary

Add reducer coverage showing that an absent capability collapses old-server
stream/durable duplicates and suppresses legacy replays. Add capable-server
coverage showing that unmatched equal rows remain distinct and that exact
matching ids reconcile without content-based merging.

Exercise the supported stable-server shape by treating missing capability
metadata as the old-server fixture. Exercise current source-ahead behavior with
the explicit capability bit.

### 5 — update the durable transcript contract

Update the capability registry documentation and
`topics/stream-durable-id-dedup.md` so the compatibility fallback and its
deliberate false-merge tradeoff are visible. Record that fallback removal is a
future compatibility-floor decision, not a time-based cleanup.

## Completion Checks

- Focused shared capability and server version tests pass.
- Focused session-detail reducer tests pass for capable, incapable, and
  capability-pending modes.
- Client and server typechecks pass.
- Capability audit, lint, format check, and client console scan are clean.
- The implementation commit contains only this tactical, the owning topic and
  capability docs, scoped source changes, and their tests.

## Completion Evidence

- [x] Permanent capability ID 48 is registered, exported, and advertised by
  source-ahead servers through the existing version response.
- [x] The source-scoped capability value reaches every session-detail
  transcript action through the coordinator.
- [x] Missing capability metadata restores approximate non-tool merge, steer
  reconciliation, and timestamp replay suppression together.
- [x] Focused shared, server, reducer, coordinator, fixture, augment, and hook
  cache tests pass without warnings.
- [x] Capability audit, repository typecheck, console scan, lint, and format
  check pass; console scan remains at its unchanged 110-warning budget.
