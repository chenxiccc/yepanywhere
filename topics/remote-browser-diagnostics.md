# Remote browser diagnostics

> Remote browser diagnostics is a proposed, explicitly consented channel through
> which an authorized operator can inspect bounded, redacted state from one
> active Yep Anywhere browser tab without granting ambient browser control.

Topic: remote-browser-diagnostics

Status: Proposal only. No browser-diagnostics protocol or remote-control
endpoint is implemented.

## Motivation

A local reproduction does not show the state of the user's actual browser:
its service-worker generation, source binding, reconnect history, DOM,
viewport, retained client state, or the exact ordering the user saw. The
missing queued `publish` incident demonstrated the gap. YA durably received the
submission, but the browser briefly hid its recovered queue chip after a live
snapshot replaced the initial REST result. Server logs established receipt;
only observation of the user's tab could have established the visible sequence
directly.

The desired capability is narrower than general remote browser automation. An
authorized agent should be able to ask one user-approved YA tab for diagnostic
facts, receive a bounded snapshot, and correlate it with server events. It
should not gain an always-on JavaScript console, input control, browser-profile
access, or other tabs.

## Existing foundations

YA already has useful pieces, but none is the proposed inspection channel:

- `ClientLogCollector` captures console output, uncaught errors, promise
  rejections, and lightweight memory/DOM counters when **Browser Diagnostics**
  is enabled. It buffers up to 2,000 entries in IndexedDB and uploads batches to
  `POST /api/client-logs`; the server persists them under
  `{dataDir}/logs/client-logs/`.
- `logSessionUiTrace`, render profiling, session-detail shadow diagnostics, and
  reload probes provide focused app-level evidence.
- Direct and relay source transports already authenticate the client/server
  relationship. Relay traffic is end-to-end encrypted, and negotiated binary
  format `0x05` provides ordered chunks of at most 256 KiB for a bounded logical
  message.

The current log collector is asynchronous evidence, not a lease or live query
API. Its presence must not be interpreted as consent to expose DOM, screenshots,
storage, network bodies, or a command channel.

## Staged design

### Milestone 0 — durable submission receipts

First make user actions traceable without any browser inspection:

1. The browser assigns an immutable submission id before sending a composer or
   queue action and reuses it for a transport retry of that same submission.
2. The server returns and durably records the same id with `serverReceivedAt`,
   accepted routing intent, durable queue id when applicable, and the last
   completed delivery boundary.
3. The UI exposes a compact lifecycle: sending, server accepted, queued or
   provider-delivered, paused after restart, rejected, or deleted.
4. Browser, server, and provider traces use that identity rather than message
   text or timestamps.

[`gaps/unconfirmed-send-loss-across-reload.md`](../gaps/unconfirmed-send-loss-across-reload.md)
tracks the current failure: browser-local and process-local optimistic echoes
can disappear without proving whether the server accepted the submission. The
receipt remains until a durable provider transcript row confirms delivery or a
terminal rejection/deletion is recorded. Reload and restart reconstruct the
same state from server evidence; they must not silently convert an unconfirmed
submission into either delivered or absent.

Recovery must be explicit and idempotent. A safe resend reuses or supersedes
the original submission identity under a server-owned rule so a late provider
confirmation cannot create a duplicate. Existing provider-specific echo
reconciliation remains useful evidence but does not replace this shared
client/server boundary; see
[`stream-durable-id-dedup.md`](stream-durable-id-dedup.md).

This milestone changes a core delivery contract. Before the client depends on
new receipt fields or routes, inspect the core stable-release horizon and
approve a new exact capability or protocol gate. Without that gate, a new
client must retain current behavior and make no unsupported receipt request.

This would have answered whether the missing `publish` command reached YA even
if live tab inspection was unavailable. It is independently useful and should
not wait for the later diagnostics channel.

### Milestone 1 — portable app-level snapshots

Add a read-only diagnostics responder to the YA web app. It should work in any
supported browser without an extension and expose only typed, allowlisted
commands:

- tab identity, build/service-worker generation, route, viewport, visibility,
  source key, transport status, and reconnect counters;
- selected YA store snapshots and generation/ownership metadata;
- a redacted semantic DOM or accessibility-oriented snapshot for a requested
  subtree, including roles, names, stable selectors, bounds, visibility, and
  limited computed layout facts;
- a bounded page from an in-memory diagnostic log ring;
- an optional screenshot requested as a separate, visibly disclosed scope;
- focused probes already owned by the app, such as session UI trace and render
  counters.

Prefer a purpose-built semantic tree over raw `outerHTML`. It is smaller,
stable enough for an agent to query, and gives masking rules one serialization
owner. When full DOM mutation history is needed, an explicitly enabled rrweb
capture can be a separate scope rather than the default representation.

### Milestone 2 — optional Chromium extension

A separately installed extension may attach to one approved Chromium tab with
`chrome.debugger` and issue allowlisted Chrome DevTools Protocol (CDP) commands.
This adds browser-owned facts unavailable to page JavaScript: accessibility and
DOM snapshots, selected network timing metadata, performance traces, and a
native screenshot.

The extension is optional and desktop-Chromium-only. Its manifest permission is
broad, and the API exposes domains including `Runtime`, `Debugger`, `Network`,
`Storage`, `Input`, and `DOM`. The YA adapter must therefore expose a narrow
operation vocabulary rather than forwarding arbitrary CDP method names. The
first version excludes JavaScript evaluation, input dispatch, cookies,
credential/storage reads, network bodies, and debugger mutation.

## Consent and security contract

Browser diagnostics crosses a trust boundary even when the agent and server
are authorized: the browser may hold credentials and page content that are not
present in the repository or server logs.

- **Per-tab lease.** The user grants a short-lived lease for one visible tab.
  It is not an account-wide or browser-wide setting. Navigation, tab close,
  source change, server generation change, expiry, or explicit revoke ends it.
- **Visible state.** The tab shows a persistent diagnostic indicator naming the
  active scopes and remaining lease time. Screenshot capture gets an additional
  immediate indication.
- **Scope allowlist.** Each lease names operations such as `app-state`, `logs`,
  `semantic-dom`, `accessibility`, or `screenshot`. Granting one never implies
  another.
- **Read-only first.** No arbitrary JavaScript, CDP passthrough, keyboard/mouse
  injection, navigation, file access, clipboard access, or storage mutation.
- **Mask before transport.** Passwords are always removed. Input, textarea,
  contenteditable, transcript, tool-result, authorization, cookie, and token
  values are masked by default. A user may opt into a narrower sensitive scope
  for one capture after previewing what category it exposes.
- **No ambient discovery.** An unleased tab may advertise only the minimum
  presence needed for the user to select it. Agents cannot enumerate DOM or
  page titles before consent.
- **Audit events.** Lease creation, scope changes, every capture, denial,
  expiry, and revoke produce a durable metadata event with requester, tab,
  scope, byte count, and result. Audit records contain no raw DOM, logs, or
  screenshot bytes.
- **Ephemeral payloads.** New high-sensitivity snapshots are not written to disk
  by default. The server brokers a response to the authorized requester and
  drops it on delivery or lease expiry. Explicit export is a separate user
  action with a named destination and retention policy.
- **Relay parity.** The public relay sees only the existing encrypted envelope.
  It must not terminate consent, inspect payloads, or become a diagnostics data
  store.

## Protocol and bounds

Use a request/response protocol with immutable ids, not an open command shell:

```text
requestId + leaseId + tabId + typed operation + scope + byte budget
response: requestId + content type + complete/truncated metadata + chunks
```

Recommended initial server-owned budgets are 1 MiB for app state or log pages
and 8 MiB for a semantic snapshot or screenshot, with existing 256 KiB
transport chunks. Larger pages are queried by subtree, cursor, time window, or
viewport region. A truncated response reports exactly which collection or byte
budget was exhausted and how to continue; no silent prefix is presented as a
complete snapshot. Compression may reduce transport cost but does not increase
the logical uncompressed limit.

Only one capture per tab should run initially. Newer requests may cancel older
ones, but cancellation must settle both browser and requester state. Continuous
recording, if later added, needs separate byte/time quotas and backpressure; it
must not reuse one-shot snapshot semantics.

## Compatibility gate

Implementation requires a new exact `/api/version` capability, provisionally
`remote-browser-diagnostics-v1`. Without it, a client renders no diagnostics
consent surface and sends no diagnostics registration or request message. An
older server therefore receives no unknown route or WebSocket message.

An extension-backed responder needs a separate dynamic capability,
provisionally `remote-browser-diagnostics-cdp-v1`, because installation and
browser support vary by host. Neither capability may broaden an existing
advertised meaning. Before implementation, inspect the required stable-release
corpus and obtain the compatibility approval required by
[Server Capabilities](server-capabilities.md). This optional feature does not by
itself justify a `remoteCompatibilityLevel` bump.

## Agent-facing interface

Expose the same typed operations through a local CLI and an MCP adapter. The
server remains the authority; neither adapter connects directly to the public
relay or browser extension.

```text
ya browser-diagnostics tabs
ya browser-diagnostics request <tab> --scopes app-state,logs --ttl 10m
ya browser-diagnostics snapshot <lease> --kind semantic-dom --selector ...
ya browser-diagnostics logs <lease> --since ... --limit ...
ya browser-diagnostics screenshot <lease> --viewport
ya browser-diagnostics revoke <lease>
```

Machine-readable results include request, lease, tab, server generation,
browser build, capture time, completeness, redaction summary, and payload
handle. Human output should state when consent is pending or a scope was not
granted rather than suggesting a workaround.

## Prior art and adoption boundary

- [rrweb](https://github.com/rrweb-io/rrweb) records an initial page snapshot
  plus DOM mutations and interactions. Its record options support input and
  text masking, with password inputs masked by default. It is a candidate for
  explicitly enabled replay capture, not the consent, transport, or
  authorization layer.
- [Chii](https://github.com/liriliri/chii) connects an instrumented page to a
  remote Chrome DevTools frontend. It demonstrates useful in-page remote
  inspection, but injecting a general DevTools target and frontend exposes a
  much broader surface than YA's typed read-only contract.
- [Chobitsu](https://github.com/liriliri/chobitsu) provides a JavaScript,
  CDP-shaped message/domain interface used by Chii. Its raw method bridge is
  useful implementation prior art but must not become YA's public protocol.
- [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
  can attach an extension to tabs and send supported CDP commands. It is the
  appropriate optional deep-inspection boundary, provided YA filters it through
  explicit operations.
- [Playwright `connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
  can adapt a Chromium CDP endpoint to familiar automation tooling, but
  Playwright documents lower fidelity than its native protocol. It belongs on
  the agent side after consent and allowlisting, not as an exposed browser
  endpoint.
- [axe-core](https://github.com/dequelabs/axe-core) can add focused
  accessibility-rule findings. It complements, but does not replace, a semantic
  or accessibility-tree snapshot.

Adopt libraries only for their bounded specialty. YA still owns identity,
consent, redaction, capability negotiation, transport, quotas, audit, and
lifetime.

## Explicit non-goals for the first implementation

- general-purpose remote DevTools;
- arbitrary JavaScript or shell execution;
- unattended or durable browser-control grants;
- cross-origin/profile inspection;
- input automation or UI mutation;
- cookie, token, local-storage, IndexedDB, or network-body extraction;
- default persistence of raw DOM, logs, screenshots, or replay recordings;
- using diagnostics as a fallback that hides missing application invariants.
