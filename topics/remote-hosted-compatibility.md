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
- Server package semver remains useful for update guidance and display, but it
  should not be the primary client/server compatibility contract because site
  and server releases use different version systems.

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
