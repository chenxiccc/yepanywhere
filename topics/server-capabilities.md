# Client And Server Capabilities

> Capabilities gate optional behavior across independently updated clients and
> servers. From 0.7.1 onward, official capabilities have permanent numeric IDs:
> release semver implies support, while sparse positive and negative bits report
> optional, source-ahead, or exceptionally withdrawn support. Names remain
> registry metadata and legacy wire data.

Topic: server-capabilities

## Source Of Truth

The permanent global ID ledger lives in
`packages/shared/src/capability-ids.ts`. The server registry in
`packages/shared/src/server-capabilities.ts` adds lifecycle, advertisement,
fallback, and route/field/event ownership metadata. Together they export:

- the exact capability string constants;
- lifecycle and advertisement metadata for each registered capability;
- the durable client/server ID ledger and sparse-bit helpers;
- a helper for checking a `/api/version`-style capability source.

The first application notification on a direct WebSocket, and the first
encrypted application notification after remote authentication, is
`client_capabilities`. A 0.7.1+ client includes its `version`,
its sparse `capabilityBits`, and the existing transport `formats`. Same-origin
HTTP has no persistent connection state, so every API request carries the same
value in `X-Yep-Client-Version`. A tunneled request inherits the version
recorded on its connection.

The server chooses the **newest encoding supported by both peers**. Encoding 1
was introduced with the version-bearing 0.7.1 handshake. A missing or older
client version selects the legacy name list; a 0.7.1+ client selects encoding
1. A git-describe source build may still name the preceding release, so the
newly present version field itself proves encoding-1 support for that source
client. Future encodings add a later semantic-version cutover and the server
chooses the highest cutover it implements that the client version reaches.

An encoding-1 `/api/version` response omits the capability name list and
returns:

- `current`, whose release semver implies every `version-implied` server
  capability with `introducedIn <= current`;
- `capabilityEncoding: 1`;
- `capabilityBits`, sparse `[wordIndex, bits]` pairs. Empty 32-bit words are
  omitted. Bits explicitly report optional capabilities and monotonic
  capabilities present in a source build ahead of its release semver; and
- optional `deniedCapabilityBits` in the same sparse form, naming known
  version-implied contracts that this server generation deliberately refuses.

The same rule applies in the other direction: a server infers permanent client
capabilities from the client's version and reads bits for optional or
source-ahead client support. Transport `formats` retain their separate byte
namespace; they are not capability IDs.

No version-aware peer expects an official 0.7.1+ capability by name. Names are
still useful in source, diagnostics, and the legacy `capabilities: string[]`
fallback. The earlier `compact-v1` query, `optionalCapabilityBits`, and
`capabilityExtensions` remain readable for compatibility with intermediate
source builds, but new clients do not negotiate that representation.

`git-file-diff-projections` owns the exact file-viewer manifest and per-file
diff routes. Releases `0.6.2` and `0.7.0` have neither route. A client without
the capability hides every file-viewer diff selector and sends no projection
request; it does not reuse `git-source-review-projections`, whose advertised
meaning predates these routes. The capability is permanent and
version-implied from `0.7.1`.

`serverHasCapability` accepts release implication, encoding-1 IDs, and both
legacy representations. This union keeps old installed servers usable without
making a new capability depend on its textual name.

### Exceptional negative overrides

`deniedCapabilityBits` is the standard negative override for a contract the
reported release would otherwise imply. A known denied ID wins over release
implication, a legacy name, and a positive source-ahead bit. Unknown denied IDs
are ignored: they describe registry entries this client does not know and must
not turn `/api/version` into an error. IDs belonging to `optional-bit` or
`scoped` capabilities are likewise irrelevant to this set; optional support is
already expressed by presence or absence of its positive bit.

Omission means no version-implied contracts are withdrawn. A legacy name-list
response instead omits the denied capability name because those clients do not
infer support from the server version. The server encoder accepts negative
overrides only for registered `version-implied` capabilities and emits an ID
only when `current` would otherwise imply that contract.

This is an exceptional compatibility escape hatch, not another availability
class. YA has no current plan to introduce a version-implied capability it
expects may be withdrawn; anticipated experimental, removable, host-dependent,
or configuration-dependent support uses `optional-bit`. A possible later
reduction in routine negative-bit traffic is kept in
[Server Capability Sketches](server-capabilities.sketches.md).

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

`public-share-management-freeze` independently advertises exact-ID batch
conversion of live grants to current frozen snapshots. It is permanent,
version-implied from `0.7.1`, and owns indexed ID 32. The split preserves the
meaning already advertised by source servers with `public-share-management`.
Without the freeze capability, the manager hides live-row and bulk freeze,
keeps inventory/copy/revocation, and makes no freeze request. Stable releases
`v0.7.0` and `v0.6.2` contain the older session-wide freeze route but neither
selective management nor the authenticated management route family, so that
session route is not a safe per-link fallback.

`public-share-session-chunks-v1` is a representation capability carried by the
secret-authorized v2 public metadata response, not a global `/api/version`
claim. It means the selected immutable primary or viewer revision supports
ordered pull reads of at most 256 KiB of compressed `session.json.gz` data per
ordinary relay request, with at most 256 chunks and 64 MiB each for compressed
and decompressed totals. The public viewer gates only on that metadata field;
an installed server's global capabilities cannot prove that one selected
revision has the required persisted integrity metadata. Releases `v0.5.2`,
`v0.6.0`, `v0.6.1`, `v0.6.2`, and `v0.7.0` lack this route and field. An
unmarked link keeps the combined response and makes no metadata request. Marked
v2 metadata without the capability keeps the one-response `wire=raw-json`
path and makes no chunk request. Relay raw-json responses are capped at 8 MiB;
larger responses return 413 with update guidance. A browser without
`DecompressionStream` takes that same raw-json path on the already-open relay
WebSocket even when metadata advertises chunks. Existing capability meanings
and the `#v=2` marker remain unchanged.

## Capability Lifecycle Classes

Use `kind: "permanent"` for client gates that remain useful indefinitely. This
includes self-hosted feature boundaries and environment-dependent availability;
the lifecycle kind does not decide how the capability is encoded.

Use `kind: "transitional"` for rollout guards that protect a new client from
showing controls that call routes, fields, or event semantics older compatible
servers do not have. Transitional capabilities must define:

- `clientFallback` - what the new client does when the capability is absent;
- `reviewAfter` - the date Maintainers should re-evaluate the gate;
- `removeClientGateWhen` - the compatibility floor or support-window condition
  that makes the client branch removable;
- `removeServerAdvertisementWhen`, when useful - when the server can stop
  advertising the string after older maintained clients no longer branch on it.

## Advertisement Classes

Advertisement is independent from lifecycle:

- `version-implied` is for a contract that is monotonic on the official release
  line. Once a stable release reaches its `introducedIn` version, later official
  releases are expected to keep that contract. A future client therefore
  normally needs only the server version and its own registry; an exceptional
  explicit negative override can deny the implication. Capabilities introduced
  after that client's build are unknown and irrelevant to it.
- `optional-bit` is for support that may be disabled, removed, host-dependent,
  or installation-dependent. Its allocated ID is sent whenever support is
  present; the ID remains reserved after retirement.
- `scoped` is for a capability advertised by another payload rather than global
  `/api/version`, such as one immutable public-share representation. It remains
  an explicit representation name in that owning payload and is outside the
  global client/server ID namespace.

IDs are global across both directions, chronological within the introducing
release, and never renumbered or reused. Every global capability introduced in
0.7.1 or later requires one, including a permanent capability normally implied
by release version. This lets a source build report the capability numerically
before its release semver can imply it. The 0.6.x optional-bit assignments seed
the same ledger:

| ID | Direction | Introduced | Capability |
| ---: | :---: | :---: | --- |
| 0 | server | 0.6.0 | `voiceInput` |
| 1 | server | 0.6.0 | `deviceBridge-available` |
| 2 | server | 0.6.0 | `deviceBridge` |
| 3 | server | 0.6.0 | `deviceBridge-download` |
| 4 | server | 0.6.0 | `deviceBridge-update` |
| 5 | server | 0.6.3 | `browser-settings-backup` |
| 6 | server | 0.7.1 | `security-client-audit-v1` |
| 7 | server | 0.7.1 | `reload-safe-codex-runtime` |
| 8 | server | 0.7.1 | `session-sandboxing` |
| 9 | server | 0.7.1 | `public-share-management` |
| 10 | server | 0.7.1 | `glossary-tooltips` |
| 11 | server | 0.7.1 | `progressive-session-catalog` |
| 12 | server | 0.7.1 | `project-directory-storage-policy` |
| 13 | server | 0.7.1 | `idle-reap-hours-setting` |
| 14 | server | 0.7.1 | `tool-result-media-preservation-policy` |
| 15 | server | 0.7.1 | `git-dirty-file-editor` |
| 16 | server | 0.7.1 | `git-source-review` |
| 17 | server | 0.7.1 | `git-source-review-submissions` |
| 18 | server | 0.7.1 | `git-source-review-projections` |
| 19 | server | 0.7.1 | `claude-gateway` |
| 20 | server | 0.7.1 | `claude-gateway-autostart` |
| 21 | server | 0.7.1 | `claude-gateway-disable-agent` |
| 22 | server | 0.7.1 | `provider-subscription-usage` |
| 23 | server | 0.7.1 | `reload-safe-codex-runtime-settings` |
| 24 | server | 0.7.1 | `host-agent-process-observability` |
| 25 | server | 0.7.1 | `session-sandboxing-status` |
| 26 | server | 0.7.1 | `project-session-defaults` |
| 27 | server | 0.7.1 | `sidebar-session-resume` |
| 28 | server | 0.7.1 | `session-fork-turn-intents` |
| 29 | server | 0.7.1 | `git-file-diff-projections` |
| 30 | server | 0.7.1 | `provider-host-control` |
| 31 | server | 0.7.1 | `remote-browser-diagnostics-v1` |
| 32 | server | 0.7.1 | `public-share-management-freeze` |
| 33 | server | 0.7.1 | `synthetic-done-command` |

The code ledger is authoritative. The next client or server capability takes
ID 34; retired rows stay in the ledger as reserved IDs.

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

The permanent capability is `project-directory-storage-policy`. It owns
`GET /api/settings`, `PUT /api/settings`, and the request/response field
`settings.projectDirectoryStorage: "app-data" | "project"`. Advertisement
attests that every audited YA-managed writer obeys the setting, absent
configuration defaults to `"app-data"`, and a mode change reconciles
revisioned authoritative Source Review state before publishing the new mode; a
server must not advertise a partial settings-only implementation.

Without the capability, the client omits the field and makes no unsupported
request. Because absence means an older server may still write into projects,
the Settings surface shows a read-only update-required explanation rather than
claiming app-data-only protection. Stable releases through `0.7.0` never
advertised this capability, so their behavior and fallback remain unchanged.
The maintainer explicitly accepted broadening the capability meaning for
post-`0.7.0` source builds that briefly advertised routing-only semantics rather
than introducing a second gate before the first stable release. The registry
`introducedIn` value remains `0.7.1`. The full behavior and audit are in
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
capabilities, such as environment-backed integrations, still use registry
constants but decide at runtime whether to advertise them. The version route
uses the client version to select the newest mutual encoding, then passes the
resulting name set through the matching encoder. Clients without a version get
the complete legacy name list.

Do not hand-write raw capability strings in the version route when a registry
constant exists. Every new global client or server capability first gets the
next never-used entry in `CAPABILITY_ID_ALLOCATIONS`. A monotonic server
contract then gets `version-implied` advertisement metadata; a dynamic or
removable contract gets `optional-bit`. Both registry definitions reference
the allocated global ID.

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

Client code should use `serverHasCapability` with registry constants or domain
helpers rather than inspecting names, bits, or semver directly. The helper
handles old-server name arrays, intermediate compact responses, global ID bits,
and release implication. Fixtures for 0.7.1+ capabilities should use a server
version or allocated bit rather than constructing a capability-name list.
Missing transitional capabilities mean "hide or degrade the optional feature,"
not "the server is broken."

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
capability checks outside registry constants/helpers, validates global ID
uniqueness and the 0.7.1 allocation floor, checks optional-bit aliases, and
verifies that every route declared by a capability-owned route module is
present in that capability's route contract (and vice versa). CI runs the
audit. New capability-owned feature families should list their route modules
in registry metadata so later route additions cannot silently escape the
advertisement.

The audit complements, rather than replaces, released-server behavior
fixtures. A capability may be registered perfectly while the client still
mounts its consumers before checking it.
