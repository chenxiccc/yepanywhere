# Server Capabilities

> Server capabilities are feature-advertisement strings returned by
> `/api/version`. They gate optional UI affordances and endpoint usage across
> new-client / older-server combinations without changing the wire shape.

Topic: server-capabilities

## Source Of Truth

The capability registry lives in
`packages/shared/src/server-capabilities.ts`. It exports:

- the exact capability string constants;
- lifecycle metadata for each registered capability;
- a helper for checking a `/api/version`-style capability source.

The registry metadata is compile-time/shared-code metadata. Do not require
older servers to return registry metadata at runtime. The wire contract remains
the existing `capabilities: string[]` field.

Every capability string advertised from `/api/version` should have a registry
entry, including permanent static features and dynamic environment/state
capabilities. Keeping the complete set in shared code lets client and server
call sites import constants instead of repeating wire strings.

For session sandboxing, `session-sandboxing-status` advertises the structured
host-preflight contract while `session-sandboxing` is dynamic and means the
local host currently has a usable enforcement backend. Clients require both
and an `available` status before showing or sending the optional launch field;
the launch path still rechecks and fails closed.

For session copying, `session-fork-turn-intents` advertises the additive
`forkKind` / `sourceMessageId` contract on the existing project-session fork
route. The client requires it together with provider `supportsForkSession`
before rendering header Clone or direct per-turn Fork. When absent, the whole
unified surface is hidden and no fork request is made; legacy server parsing is
not treated as a client fallback. This transitional gate was introduced in
`0.7.1` and is reviewed after 2026-09-01.

## Capability Classes

Use `kind: "permanent"` for capabilities that may vary indefinitely across
servers or installations. Examples include server feature families, environment
availability, or optional integrations that genuinely might not exist.

Use `kind: "transitional"` for rollout guards that protect a new client from
showing controls that call routes, fields, or event semantics older compatible
servers do not have. Transitional capabilities must define:

- `clientFallback` - what the new client does when the capability is absent;
- `reviewAfter` - the date Maintainers should re-evaluate the gate;
- `removeClientGateWhen` - the compatibility floor or support-window condition
  that makes the client branch removable;
- `removeServerAdvertisementWhen`, when useful - when the server can stop
  advertising the string after older maintained clients no longer branch on it.

## When To Add One

Add a server capability when:

- a visible UI control depends on a server route, response field, or event
  behavior older compatible servers lack;
- feature availability genuinely varies by server environment;
- the old/new mismatch would create a confusing click path or broken visible
  affordance.

Do not add a capability for:

- internal implementation details;
- required protocol changes, which belong in `remoteCompatibilityLevel` or a
  dedicated protocol version;
- requests the client can attempt and recover from invisibly without changing
  the user-visible experience.

Capability flags are feature hints. They are not a substitute for protocol
compatibility levels when a hosted client must stop supporting an older server
class entirely.

## Minimum Compatibility Horizons

Capability fallbacks are user-facing support contracts, not rollout
conveniences. Before a current client depends on a server contract absent from
a stable release, classify the feature and inspect:

- for an ordinary optional feature, the latest two stable releases and every
  stable release from the preceding 14 days;
- for core functionality, the latest two stable releases and every stable
  release from the preceding 60 days.

These are minimum horizons. Reaching the end of one only makes a fallback
eligible for maintainer review; it does not remove the fallback, expand an
existing capability, or raise a compatibility floor automatically. Preserve a
cheap fallback longer when practical.

Before implementation, record the release corpus, new routes/fields/events,
capability or protocol decision, exact absent-capability behavior, and proof
that the fallback makes no unsupported request. A maintainer must approve that
plan. Any proposal to reuse or broaden an already-advertised capability needs
particular scrutiny: an older server has already claimed the old meaning and
cannot acquire new routes retroactively.

## Server Use

`packages/server/src/routes/version.ts` advertises capability names from the
shared registry. Static capabilities can be included directly. Dynamic
capabilities, such as environment-backed integrations, should still use the
registry string constants but decide at runtime whether to advertise them.

Do not hand-write raw capability strings in the version route when a registry
constant exists.

## Client Use

Client code should compare against registry constants or domain helpers rather
than string literals. Missing transitional capabilities mean "hide or degrade
the optional feature," not "the server is broken."

For visible controls, prefer gating before rendering. A defensive request error
path is still useful, but it should not be the primary compatibility behavior.

## Cleanup

Periodically audit transitional capabilities:

1. Find all registry entries with `kind: "transitional"`.
2. Check whether `reviewAfter` has passed.
3. If the current hosted-client compatibility floor excludes servers missing
   the capability, remove the client gate and fallback branch.
4. Keep server advertisement for one more support window if older maintained
   clients may still branch on the string.
5. Retire or remove the registry entry once no maintained client or server
   code depends on it.

`pnpm capabilities:audit` lists due transitional capabilities, rejects raw
capability checks outside registry constants/helpers, and verifies that every
route declared by a capability-owned route module is present in that
capability's route contract (and vice versa). CI runs the audit. New
capability-owned feature families should list their route modules in registry
metadata so later route additions cannot silently escape the advertisement.

The audit complements, rather than replaces, released-server behavior
fixtures. A capability may be registered perfectly while the client still
mounts its consumers before checking it.
