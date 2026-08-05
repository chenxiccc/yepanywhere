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

For authenticated public-share management, `public-share-management`
advertises compact inventory plus opaque-id single-link and confirmed global
revocation. A client without it preserves the existing session sharing popup
and Settings kill switch, hides the direct/global manager entries, leaves the
browser context menu unchanged, and sends no management request. Storage
readiness is reported by the routes themselves and is not inferred from an
empty inventory.

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

### Planned storage policy gates

The project-directory storage correction is a core trust/default change. Its
2026-08-03 60-day stable corpus is `0.5.2`, `0.6.0`, `0.6.1`, `0.6.2`, and
`0.7.0`; `0.5.0` and `0.5.1` are also audited because `0.5.0` introduced the
project-local attachment default. Every one of those releases lacks a storage
setting and every release from `0.5.0` through `0.7.0` writes uploads to
`.attachments/`. No stable release contains the later tool-result, review,
author-palette, or managed-exclude writers.

The proposed permanent capability is `project-directory-storage-policy`. It
owns `GET /api/settings`, `PUT /api/settings`, and the request/response field
`settings.projectDirectoryStorage: "app-data" | "project"`. Advertisement
attests that every audited YA-managed writer obeys the setting and that absent
configuration defaults to `"app-data"`; a server must not advertise a partial
settings-only implementation.

Without the capability, the client omits the field and makes no unsupported
request. Because absence means an older server may still write into projects,
the Settings surface shows a read-only update-required explanation rather than
claiming app-data-only protection. Existing capability meanings and older
server behavior remain unchanged. The implementation release supplies the
registry `introducedIn` value. The full behavior and audit are in
[Project Directory Storage](project-directory-storage.md).

### Session-catalog gate

Approved 2026-08-05. Global session lists and Inbox move from request-complete
enumeration to a progressive retained snapshot, so the client begins sending a
known generation on revalidation and relies on answers older servers cannot
give.

The permanent capability is `progressive-session-catalog`. Permanent rather
than transitional because YA is self-hosted with no forced upgrade: the
population of older servers never converges, so the gate never becomes
removable. Absent the capability the client keeps today's complete-request
enumeration and issues no unsupported request. Existing provider and session
capabilities, and explicit session-detail reads, are unchanged.

**The fallback is the contract, and it is a performance floor, not a feature
floor.** An out-of-date client must still perform basic actions against a
current server, and a current client against an out-of-date server, at some
non-optimal performance level. The ungated path therefore stays a working
enumeration rather than a degraded stub, and that — not the size of the release
corpus audited — is what a review of this gate should check.

**The wire surface is `GET /api/sessions`.** The response carries
`generation`; a request may carry `knownGeneration`, and a match answers
`{ unchanged: true, generation }` without walking any project. Three rules a
caller must respect, because none is enforceable from the server side alone:

- a token is only meaningful against **identical query parameters**. The
  generation covers the collection, not a particular filter, so replaying a
  token from a different `project` / `q` / `starred` / `includeArchived` read
  would claim rows the client does not have. Cursor pages (`after`) never
  short-circuit for the same reason.
- a client without the capability must not send `knownGeneration` and must
  ignore `generation`; an older server silently ignores the parameter and
  returns a full response, so the fallback is safe either way.
- a token claims the client **still holds those rows**, which is a claim about
  coverage as well as content. `unchanged` is a truthful answer to a consumer
  asking for a wider window than it retains, and a useless one: it would leave
  that consumer permanently short of rows. Offer the token only when the
  retained collection already covers the request.

Both halves have landed. `useGlobalSessionsFeed` offers its accepted generation
on automatic revalidation and treats `unchanged` as keeping its retained rows;
an explicit user refresh always asks for rows, since that is a fidelity request
rather than a freshness one. Bounded deltas, and the cross-tab/IndexedDB
persistence in the same plan step, are not built.

Tool-result preservation is independently gated by the proposed permanent
`tool-result-media-preservation-policy` capability. It owns `GET
/api/settings`, `PUT /api/settings`, and
`settings.toolResultMediaPreservation: "on-demand" | "preserve"`.
Advertisement attests that absent configuration defaults to `"on-demand"`,
that on-demand and historical session-detail reads create no persistent media
copy, that preserve mode captures only new results emitted by managed
sessions, and that preserved copies have no automatic pruning or eviction.

No stable release through `0.7.0` contains tool-result media handles or
preservation. A new client connected to a server without the capability omits
the field and shows a read-only update-required explanation; it does not infer
safe on-demand semantics because an unadvertised post-`0.7.0` source build may
contain the unconditional materializer. Existing capability meanings remain
unchanged. The complete UI and timing contract is in
[Storage Settings](storage-settings.md).

## Server Use

`packages/server/src/routes/version.ts` advertises capability names from the
shared registry. Static capabilities can be included directly. Dynamic
capabilities, such as environment-backed integrations, should still use the
registry string constants but decide at runtime whether to advertise them.

Do not hand-write raw capability strings in the version route when a registry
constant exists.

### Snapshot delivery

`/api/version` is a shared compatibility snapshot, not a per-component probe.
The client retains one resolved snapshot per connected source and all
capability consumers subscribe to it. A reconnect or explicit refresh may
revalidate that source; mounting another component must not issue a new request.
When a validation field such as speech-backend readiness is temporarily
pending, one source-level owner schedules the follow-up rather than every hook
instance starting its own timer.

Ordinary server reads assemble the response from retained state. Static
process/build facts such as the development `git describe` result and install
source are computed once per server generation. Dynamic services such as
sandbox or device-bridge availability own their own bounded snapshots and
in-flight coalescing. `fresh=1` remains the explicit path for bypassing the
applicable caches; a normal capability read must not repeatedly launch Git,
package-manager, sandbox, bridge, or provider subprocesses.

This delivery contract does not change any capability's meaning and therefore
does not itself require a new capability flag. A new route or response field
used to implement a feature still follows the compatibility-horizon rules
above.

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
