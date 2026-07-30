# Multi-Host Monitor And Coexistence Harness

Status: Existing-transport series landed 2026-07-30. Relay multiplexing is a
separate, compatibility-gated follow-up.

Topic: client-source-runtime-topology
Topic: source-transport

## Origin

The summary-only session render mode makes a small multi-host client practical:
an experimental browser route can show whether several saved YA servers are
connected and surface compact activity without first reproducing the complete
desktop UI on Android.

The client already stores multiple hosts and has source-scoped runtimes, but it
has not mounted several real secure relay sources in one page. The current
coexistence E2E proof uses one localhost source and one plain direct WebSocket
source. Separate relay tests prove one real SRP login and resume. Neither test
proves that three relay-backed sources can coexist without state, auth, or
reconnect leakage.

A future relay `/mux` transport could reduce the phone or browser side from one
physical WebSocket per host to one physical WebSocket per relay URL. Building
the monitor, multi-source controller, relay protocol, and all failure behavior
in one change would make failures difficult to localize. This plan therefore
proves the product behavior over the existing relay transport before changing
relay framing.

## Sequencing Decision

The work is two separate implementation series:

1. **Existing transport:** run several ordinary `SecureConnection` instances,
   build the real multi-server Playwright harness, and expose the minimal
   experimental monitor.
2. **Relay mux:** after the first series passes its exit gate, define and
   implement one relay WebSocket carrying several independently authenticated
   logical circuits. Re-run the same browser contract with a different
   physical-socket expectation.

The first series must not contain relay mux protocol code. The second series
must not weaken or replace the legacy connection path.

## First-Series Product Shape

### Experimental entry point

- Use `/-/monitor` as the working remote-client route. The `-` segment cannot
  be a valid relay username, so it does not collide with the existing
  `/:relayUsername/*` routes.
- The route is experimental and deliberate-entry only. A development setting
  may expose an **All Hosts (Experimental)** link near **Switch Host**.
- The feature remains default-off/hidden and does not change the ordinary
  single-host experience.

### Initial host policy

- On mount, consider all saved hosts selected for this first proof.
- Automatically connect only hosts with a stored resumable session.
- Show a per-host **Sign in required** state when no resumable session exists;
  do not open several login dialogs.
- A later slice may persist an active/inactive subset. Saved and active must
  remain separate concepts before this becomes a normal product surface.
- Mounting the route acquires the source connection/activity leases. Leaving
  it releases those leases and does not leave background reconnect or polling
  work alive indefinitely.

### Minimal display

The first UI is a diagnostic monitor, not a merged navigation redesign. It
shows:

- `Connected N of M`, where `M` is the selected host count and `N` is the
  number currently ready;
- one row per host with display name and an explicit connecting, connected,
  offline, or sign-in-required state; and
- enough source-specific summary data to prove that each row is backed by its
  own YA server rather than by an aggregate counter.

The page may later add compact working, needs-attention, and recently-completed
session summaries. Merged projects, merged session ordering, and a complete
Agents or Inbox redesign are not part of the first proof.

### Failure isolation

- Hosts become ready progressively; the page never waits for all hosts before
  showing usable results.
- One offline server, rejected resume, or auth failure changes only that
  source's row and does not trigger an app-wide login redirect.
- Disposing or deactivating one source leaves the other runtimes, requests,
  subscriptions, and cached summaries intact.
- Identical project and YA session ids from different servers remain
  source-scoped.

## Harness Topology

The dedicated Playwright fixture runs:

```text
one remote-client browser
  -> one local relay
    -> YA server/profile alpha
    -> YA server/profile beta
    -> YA server/profile gamma
```

This is one client connecting to three server targets, not three browser
clients. In the first series the browser uses three ordinary client-to-relay
WebSockets. Each YA server keeps its existing server-to-relay waiting and
replacement connection behavior.

### Process fixture

Extract the reusable server startup and teardown behavior from
`packages/client/e2e/source-transport-coexistence.spec.ts` rather than adding
three permanent processes to global setup.

A `MultiHostRelayHarness`-style worker or suite fixture should:

- start one relay on an assigned port;
- start three YA server child processes with distinct temporary
  `YEP_DATA_DIR`, Claude, Codex, and Gemini directories;
- assign each profile a unique relay/SRP username and install identity;
- configure all three against the same relay URL through their local admin
  APIs;
- wait on health and relay status through polling, never fixed sleeps;
- capture stdout/stderr separately per profile and surface the relevant logs
  when a test fails; and
- terminate process groups and remove only its own temporary roots in teardown,
  including failure paths.

The fixture returns explicit records such as:

```ts
interface MultiHostFixture {
  relay: {
    wsUrl: string;
    statusUrl: string;
  };
  hosts: Array<{
    id: string;
    displayName: string;
    username: string;
    password: string;
    adminBaseUrl: string;
    expectedFixtureText: string;
  }>;
}
```

Do not use fixed ports or a shared profile directory. Reusing a data directory
would collapse server identity and make reconnect/session behavior
unrepresentative.

### Collision-oriented fixture data

Give alpha, beta, and gamma the same project path-derived id and the same
YA-visible session id, but a distinct persisted message or summary marker:

- `Alpha previous message`
- `Beta previous message`
- `Gamma previous message`

Successfully reading all three markers is a stronger isolation assertion than
checking three connection booleans. It catches cache, runtime, request, and
route-key leakage.

### Real SRP session provisioning

Most monitor tests should not click through the login form three times. Add an
E2E-build-only browser helper, following the existing source-transport smoke
helper pattern, which:

1. constructs the production `SecureConnection` for each fixture host;
2. performs the real relay pairing and SRP/NaCl handshake;
3. captures the emitted `StoredSession`;
4. closes the bootstrap connection cleanly; and
5. returns saved-host records that Playwright writes to
   `yep-anywhere-saved-hosts`.

This is orchestration, not an auth bypass: passwords and session keys still go
through the production protocol. No test-only server authentication endpoint
should be added.

Keep one separate browser test that enrolls several hosts through the visible
login/host-switch flow. Dashboard state and failure tests may use the faster
provisioning helper so a login-form change does not invalidate every
multi-source assertion.

## First-Series Test Matrix

### Fast ownership tests

Before the full browser test, cover the multi-source controller with fake
transports:

- progressive readiness and aggregate count;
- source-scoped summary selection;
- one-source auth/offline failure;
- source removal/disposal; and
- stale completion from a disposed source.

These tests make UI state failures cheap to diagnose but are not evidence of
secure/relay coexistence by themselves.

### Real browser tests

The required Playwright scenarios are:

1. **Three valid resumes:** all hosts reach ready and the page shows all three
   distinct fixture markers.
2. **One offline username:** the page settles at `Connected 2 of 3`; both
   healthy sources continue serving requests.
3. **One stale or invalid session:** only that host reports sign-in required;
   the other two remain ready.
4. **One source disconnects after readiness:** only its status and data become
   unavailable.
5. **Dispose one source:** the other two continue to serve requests and
   activity.
6. **Colliding ids:** fetching the same project/session ids from all profiles
   returns the correct source-specific content.
7. **Route teardown:** leaving the monitor releases its runtimes and does not
   leave reconnect loops or streams running.

Add deterministic provider-backed activity only when the monitor starts
claiming Agents/Inbox-style live activity. Connection state and persisted
summary data are sufficient for the first minimal status surface; they are not
evidence for multi-provider live stream support.

### Existing-transport socket assertion

Filter Playwright's `page.on("websocket")` observations to the configured
relay URL so the Vite/HMR socket is irrelevant. With three selected relay hosts
on one relay, the first series deliberately expects three ordinary
client-to-relay WebSockets.

The assertion is valuable even before mux: it establishes the baseline that
the later series must reduce without changing the visible behavior.

## First-Series Slices

### Slice A0 — reusable process harness

Status: Landed 2026-07-30.

- Extract isolated YA server profile startup/health/cleanup support.
- Generalize it from one secondary server to a named array of profiles.
- Preserve the existing localhost plus plain-WebSocket coexistence smoke.

### Slice A1 — secure relay coexistence proof

Status: Landed 2026-07-30.

- Provision three real relay/SRP sessions.
- Instantiate three source runtimes without adding the monitor UI.
- Prove independent requests, same-id isolation, activity ownership, and
  disposal.
- Resolve any remaining global auth-required behavior before presenting
  multi-host failure states.

### Slice A2 — experimental monitor

Status: Landed 2026-07-30.

- Add the hidden route and optional development-setting link.
- Add explicit cross-source selectors/controller state; do not repurpose a
  hidden global current-source selector.
- Render the minimal aggregate count and per-host states.
- Add desktop and phone interaction coverage.

### Slice A3 — failure and lifecycle gate

Status: Landed 2026-07-30. The existing-transport exit gate is green.

- Add offline, stale-session, late-disconnect, and route-teardown scenarios.
- Verify warning-free focused tests, lint, typecheck, client console budget,
  and the full relevant E2E suite.
- Capture and inspect the final result at 1920x1080 and 375x812.

The browser suite now covers visible three-host enrollment, genuine SRP
provisioning, three ordinary relay sockets, colliding project/session ids,
offline and stale-session isolation, a connected source dropping, explicit
single-source disposal followed by successful requests through both peers, and
route teardown returning all relay targets to waiting.

Reviewed final captures:

- `.artifacts/ui-testing/2026-07-30-multi-host-monitor/multi-host-monitor-desktop.png`
  (1920x1080)
- `.artifacts/ui-testing/2026-07-30-multi-host-monitor/multi-host-monitor-phone.png`
  (375x812)

The reviewed layouts keep the experiment label and saved-host escape visible,
use one card per source with clear readiness and summary grouping, collapse to
one column without horizontal overflow, and leave the third phone card
reachable by normal vertical scrolling.

## Exit Gate Before Relay Mux

Do not begin mux implementation until the existing-transport series proves:

- three real secure relay sources coexist in one browser;
- visible and stored data remain source-scoped under colliding ids;
- one-source auth and transport failures stay local;
- route teardown releases background work;
- the expected three browser-to-relay sockets are directly observed; and
- the minimal UI is usable at desktop and phone widths.

If this gate exposes a runtime, auth, or cache ownership problem, fix and prove
that boundary over existing transports. Do not hide it inside mux code.

## Later Relay Mux Series

The first-series exit gate is green. The relay mux contract and compatibility
audit now live in
[`topics/relay-client-mux.md`](../../topics/relay-client-mux.md). Its
implementation remains paused for the required maintainer approval.

That contract defines:

- `/mux` discovery and a new capability/protocol gate;
- the exact outer frame and circuit lifecycle;
- independent SRP/resume state and encryption keys per circuit;
- circuit ids, open/close/error semantics, timeouts, and reconnect ownership;
- fair per-circuit scheduling and buffer limits;
- maximum circuits plus per-socket, per-IP, and per-target open-rate limits;
- behavior for offline usernames, invalid proofs, and slow circuits;
- relay observability for physical connections and logical circuits; and
- legacy fallback when mux is unavailable.

The current design input is one physical client-to-relay WebSocket per relay
URL, with distinct server usernames opened as logical circuits. The relay
routes opaque inner SRP/NaCl/YA frames and does not become an account,
membership, or application federation service. Independent servers still
perform independent handshakes and can become ready at different times.

Head-of-line blocking is acceptable initially for small summary/activity
traffic only if fair per-circuit queues prevent one busy circuit from starving
the rest. Bulk/media traffic may remain on a dedicated legacy socket if
measurements show the shared transport is unsuitable.

Before client or relay contract edits:

1. inspect the supported stable release corpus required by
   `topics/server-capabilities.md` and
   `topics/remote-hosted-compatibility.md`;
2. present the capability/discovery and missing-capability fallback for
   maintainer approval;
3. keep the existing `/ws` path and capability meanings unchanged; and
4. ensure a client never attempts `/mux` until support is known.

The intended fallback is exact behavioral parity through ordinary independent
relay sockets. Mux is an optional transport optimization, not a new
requirement for the monitor.

### Mux verification

Reuse the first-series browser scenarios. In mux mode, change the transport
assertions to require:

- exactly one browser WebSocket to `/mux` for the shared relay URL;
- three independently ready logical circuits;
- distinguishable source data from all three real YA servers; and
- one circuit failure or closure without disturbance to the other two.

Add lower-level relay integration tests first using one raw mux client and
three registered server sockets. Those tests own framing, routing, quota,
fairness, and circuit lifecycle. The browser suite owns full SRP/resume,
runtime isolation, fallback, and user-visible behavior.

## Non-Goals

- Building the Android client before the web proof is reliable.
- Calling the monitor or relay transport “federation.”
- Allowing one relay username to identify several YA servers.
- Changing ordinary single-host routes or defaults.
- Requiring mux for the experimental monitor.
- Merging full projects, transcripts, or source-control views in the first
  series.
- Treating fake transports or fabricated stored sessions as full E2E proof.

## Related Work

- [`051-client-source-runtime-topology.md`](051-client-source-runtime-topology.md)
- [`057-source-transport-boundary.md`](057-source-transport-boundary.md)
- [`../project/multi-host-plan.md`](../project/multi-host-plan.md)
- [`../../topics/client-source-runtime-topology.md`](../../topics/client-source-runtime-topology.md)
- [`../../topics/source-transport.md`](../../topics/source-transport.md)
- [`../project/relay-design.md`](../project/relay-design.md)
- [`../project/connection-matrix.md`](../project/connection-matrix.md)
