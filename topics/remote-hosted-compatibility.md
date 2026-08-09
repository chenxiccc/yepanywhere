# Remote Hosted Compatibility

Topic: remote-hosted-compatibility

Status: Level metadata and hosted warning implemented.

Progress:

- [x] 2026-06-30: Advertise `remoteCompatibilityLevel: 10` from `/api/version`
  and relay compatibility metadata.
- [x] 2026-06-30: Add the hosted remote warning for missing or lower levels,
  treating missing as level `0`.

The hosted remote UI can move ahead of npm-installed YA servers because the
website/latest client and the server package are released on different
cadences. Exact feature capability flags are still necessary, but they are too
fine-grained to answer the product question: "is this hosted client broadly
newer than the server it is controlling?"

Use a coarse hosted-remote compatibility level for that question.

## Contract

Expose a server-owned numeric level through `/api/version` and relay
compatibility metadata:

```ts
interface VersionInfo {
  remoteCompatibilityLevel?: number;
}
```

The hosted client bakes in two thresholds:

```ts
const REQUIRED_REMOTE_COMPATIBILITY_LEVEL = 0;
const RECOMMENDED_REMOTE_COMPATIBILITY_LEVEL = 10;
```

- `required` is for hard safety or protocol assumptions. A server below this
  level should be blocked only when the hosted client cannot safely provide
  basic remote use.
- `recommended` is for broad app-server drift. A server below this level should
  show a high-priority update warning, but basic remote use should continue
  whenever it remains safe.

Missing `remoteCompatibilityLevel` means "old server, level 0" for warning
purposes. Do not infer a hard cutoff from absence alone.

## Client URL compatibility

Hosted and root-built clients share one router-path grammar. Relay-host routes
are canonical under `/-/relay/:relayUsername/*`; the hosted browser URL adds its
configured application base, normally `/remote/`. The current client redirects
legacy username-at-root links only when the first segment is a valid relay
username and is not reserved by an application route. Canonical routes may use
reserved application names as relay usernames without collision.

React Router navigation applies the configured base automatically. Raw browser
navigation, service-worker paths, and raw-path route classification must apply
the same base explicitly. Source-runtime selection parses the canonical and
legacy route grammars through the same route owner so rendering a connected
shell cannot bind its queries to a different source.

This URL migration is client-owned and requires no server capability. Existing
servers see the same authenticated HTTP and WebSocket requests after the client
resolves the route.

## Initial Rollout

The first implemented level is `10`.

Reasoning:

- existing deployed servers do not report the field, so they will evaluate as
  level `0`;
- the hosted client has accumulated many new surfaces since the last
  coordinated release, and some may rely on server behavior that is not fully
  capability-gated;
- level `10` gives the first visible compatibility marker room to mean "current
  generation of hosted remote", not "the first tiny capability flag."

Initial client behavior:

- `REQUIRED_REMOTE_COMPATIBILITY_LEVEL = 0`;
- `RECOMMENDED_REMOTE_COMPATIBILITY_LEVEL = 10`;
- missing or `< 10` shows a strong, non-blocking update warning in hosted
  remote;
- level `10+` suppresses the general hosted-client/server drift warning.

Suggested copy direction: "This hosted client is newer than your local YA
server. Basic remote use should still work, but update the server soon to avoid
missing or unstable newer remote features."

## When To Bump

Bump the level when a hosted remote release starts broadly depending on newer
server behavior, or when a release has enough new server-backed UI that a single
"new client vs old server" warning is more useful than trusting every feature to
be perfectly gated.

Do not bump it for every small feature. For narrow independent features, keep
using explicit capability flags such as `projectQueue` or `git-status-push`.
Frequent bumps make the warning noisy and train users to ignore it.

Good bump triggers:

- new app-server protocol or request/response shape used across several
  screens;
- major server-backed UI release where older servers are expected to produce
  partial or confusing behavior;
- renderer or transcript contract changes whose absence cannot be expressed by
  a single feature flag;
- a security or transport hardening release that is not already covered by a
  dedicated protocol version.

Poor bump triggers:

- a single button hidden by an exact server capability;
- copy/layout-only hosted UI changes;
- provider catalog changes already represented by server-returned model or
  provider metadata.

## Relationship To Other Signals

`remoteCompatibilityLevel` is a coarse warning signal, not a replacement for
the existing compatibility metadata.

- Protocol fields such as `resumeProtocolVersion` carry hard compatibility and
  security meaning. They remain the basis for grace periods and cutoffs.
- Future `renderProtocolVersion` should carry specific renderer/transcript
  contract meaning once that contract exists.
- Capability flags remain exact feature gates. A client must still hide or
  degrade individual server-backed actions when their required capability is
  missing.
- Server package semver carries only registry-declared monotonic capability
  implication and remains useful for update guidance and display. It is not a
  broad compatibility contract: optional capability bits and protocol levels
  still carry facts that release ordering cannot express, and site/server
  releases use different version systems.

## Client-advertised transport formats

`ClientCapabilities.formats` negotiates binary wire formats independently of
`/api/version` capabilities. A server may emit a format only after that client
advertises it. Unknown format numbers in a capability list have no effect on an
older server.

Format `0x05` carries one contiguous part of an already encoded binary message.
The sender compresses and encrypts first, then divides the resulting envelope;
the receiver reassembles the exact envelope before decryption or JSON parsing.
Each physical chunk carries at most 256 KiB of data plus its format byte and
12-byte message-id/offset/total header. One connection accepts one strictly
ordered message at a time and retains at most 64 MiB for reassembly. Missing,
interleaved, oversized, or interrupted sequences fail closed. File uploads keep
their existing `0x02` format and 64 KiB application chunks.

New direct and secure clients advertise `0x05`. A new server sends bounded
chunks only to those clients; without `0x05`, it preserves the complete-frame
behavior. The supported core release corpus (`v0.5.2`, `v0.6.0`, `v0.6.1`,
`v0.6.2`, and `v0.7.0`) already accepts `client_capabilities` on the shared
WebSocket router and stores unknown format values without acting on them, so a
new client remains compatible with those servers.

YA's direct WebSocket server, relay client, and public relay retain the existing
100 MiB compatibility allowance for one physical inbound WebSocket message.
The relay exposes that value as `RELAY_WEBSOCKET_MAX_MESSAGE_BYTES`, but cannot
inspect end-to-end encrypted capability negotiation; lowering a production
default could reject a complete frame from an older supported peer. Operators
may exercise a lower admission boundary without changing the application chunk
contract. Large historical localhost responses may travel over direct HTTP
instead, while live WebSocket events use the negotiated binary format. Relay
mux framing remains unchanged: a complete transport-chunk frame is at most
256 KiB + 13 bytes, below the incumbent 2 MiB opaque mux-frame default, and
requires no new mux flag.

## Support Horizon

The coarse compatibility level does not shorten feature-level support. Apply
the minimum horizons from
[server-capabilities](server-capabilities.md#minimum-compatibility-horizons):
latest two stable releases plus 14 days for optional functionality, and latest
two plus 60 days for core functionality. A current hosted client should retain
usable core behavior throughout that corpus whenever the older server
advertises the established capability.

Crossing a horizon authorizes a maintainer decision, not an automatic cutoff.
Any cutoff still records the affected release corpus, user-visible warning,
fallback that is being removed, and reason continued compatibility is no
longer safe or practical. Cheap exact-capability fallbacks may remain
indefinitely.

## Notice Behavior

Use the existing remote compatibility notice model.

Recommended severity for the initial `0 -> 10` gap: high-priority
`recommended`, not `blocking` and not `security`, unless the same release also
introduces a specific protocol/security issue covered by its own notice.

Dismissal should be scoped by server identity, notice id, and the triggering
level pair, for example:

```text
remote-notice-dismissed:<install-or-relay>:remote-compat-level:0-to-10
```

That lets a user snooze the initial warning without hiding a later `10 -> 20`
warning.

## Release Discipline

When publishing a hosted remote client with a higher recommended level:

1. Land the YA server support first or in the same release train.
2. Publish/update server release notes with the level and the reason for the
   bump.
3. Update the hosted client threshold and notice copy.
4. Keep exact capability gates for each new server-backed feature.
5. Use relay/update telemetry when available to decide whether any future
   `required` bump or hard cutoff is justified.

This level is a product compatibility marker. It should be bumped deliberately,
with a one-line reason in the release notes or tactical doc, rather than as an
automatic counter tied to every merged feature.

## Synchronized distribution is the intent, not the guarantee

The maintainer publishes the hosted remote client together with the server code
it talks to, so in the normal case a connected client is the same vintage as
its server. Design for that: it is why a routine internal change does not need
a negotiated protocol, and why the migration cost of a new server-owned value
is ordinarily one release rather than a dual-path rollout.

Do not promote that intent into an assumption the code may rely on. It is a
release practice, and release practices have failure modes that are ordinary
rather than exotic:

- a native/Android client the user has not updated, which no server-side
  publish can reach;
- a GitHub Pages deploy that half-lands, so new HTML is served against old
  hashed assets or the reverse;
- a browser or service worker serving a cached bundle after a successful
  publish, which is why the Pages deploy deliberately keeps prior assets
  (`CLAUDE.local.md` § Remote Client Publish);
- a publish that was simply forgotten, or a server restarted onto newer code
  while clients stay connected across it.

In each of those the version skew is real and the user is not at fault, so
capability gates, [server-capabilities](server-capabilities.md) advertisement,
and the compatibility level above keep earning their cost. Their job here is
not to support a long tail of old releases — the support horizon governs that —
but to make a *transient, accidental* skew degrade legibly instead of throwing.
The synchronized-publish intent lowers how much dual-path behavior is worth
building; it does not remove the gate, and a feature that hard-fails against a
one-release-old client is still a defect.

Upstream (`origin`/kzahel) is a different matter entirely: those users run
their own servers and clients on their own schedule, so nothing here relaxes
the review CLAUDE.md requires for changes on that path.
