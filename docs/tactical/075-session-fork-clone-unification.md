# Session Fork And Clone Unification

Status: product and compatibility direction approved 2026-08-01;
implementation and paid-provider validation remain paused until the Maintainer
explicitly says to proceed. No runtime changes have been made from this
tactical.

Topic: fork-from-turn
Topic: provider-fork-support
Topic: turn-rail-marker-layout

Related topics:
[session-context-actions](../../topics/session-context-actions.md),
[fork-from-turn](../../topics/fork-from-turn.md),
[provider-fork-support](../../topics/provider-fork-support.md),
[turn-rail-marker-layout](../../topics/turn-rail-marker-layout.md),
[provider-context-economics](../../topics/provider-context-economics.md),
[codex-user-turn-provenance](../../topics/codex-user-turn-provenance.md),
[server-capabilities](../../topics/server-capabilities.md), and
[vanilla-defaults](../../topics/vanilla-defaults.md).

## Objective

Make a complete session copy obvious and dependable, make prefix forks work at
real user-turn boundaries on every advertised provider, and remove the current
requirement that a user understand YA's separate clone, fork, restart, turn
rail, and fork-summary implementations before choosing a safe action.

This is a repair and simplification pass, not a new conversation-tree product.
The existing provider `forkSession` primitive remains the foundation. The work
is to give it one trustworthy server-owned boundary model and a small, honest
set of user actions.

## Approved Product Model

The Maintainer approved using three distinct words for three distinct outcomes:

| Action | Meaning | Source session | New session |
| --- | --- | --- | --- |
| **Clone** | Copy through the latest completed response | Unchanged and still available | Opens cold with no new user turn |
| **Fork before/after** | Copy a prefix at an explicit completed-turn boundary | Unchanged and still available | Opens cold at the selected boundary |
| **Handoff** | Start a successor from bounded or generated context | May deliberately retire the source process | Starts with an explicit handoff turn |

Generated-summary fork is an explicit advanced form of **Fork after**, not the
default meaning of Clone and not an implicit interpretation of whatever text
happens to be in the composer.

The implementation decisions fixed by that approval are:

- Clone is a direct session-header action, not a doorway into Fork with summary
  or Handoff.
- Clone navigates in the same tab to a cold target titled `Clone: <source>`,
  with an empty composer. The source and its draft remain untouched.
- A normal per-turn Fork is message-less. Fork with summary remains an explicit
  secondary action.
- Clone and Fork after are disabled while the selected/latest turn is active;
  the first implementation does not wait implicitly.
- The first implementation adds Clone to the session header, not every session
  list row.
- The target keeps the source provider, model, project/workstream, sandbox
  settings, and YA parent lineage.

This approval is also the deliberate default-on product decision required by
`topics/vanilla-defaults.md`: Clone is a familiar, explicitly invoked copy
action, creates no provider turn, and does no background work before the user
selects it.

### Clone should be direct, not a doorway into the current fork UI

Put **Clone** back in the session-header overflow menu. Selecting it should
create a full, message-less fork and navigate to it. It should not first open
the fork-after-summary composer, ask the user to pick a turn, compact the
source, send `Continue from this fork point.`, or retire the source process.

The implementation should use the modern provider-native full fork
(`POST .../fork` with no boundary), not restore the legacy storage-copy
`POST .../clone` action. The legacy clone route remains an internal mechanism
for `/btw` providers until those consumers are migrated or deliberately kept.

The header action is the mandatory discovery surface. Adding Clone to every
session-list row is optional follow-up; `SessionMenu` is shared, so the header
instance should receive an explicit handler without automatically expanding
all row menus.

### Fork should be a turn action, with no turn-rail dependency

Every real user prompt must have an operable turn action surface on desktop and
touch layouts:

- the first turn offers **Fork after** once its response is complete;
- later turns offer **Fork before** and **Fork after**;
- a boundary that cannot exist is omitted or visibly disabled, never presented
  as a button that can only toast an error; and
- the right-side turn rail remains an accelerator, not the sole owner of an
  action.

The default fork action creates a cold fork with no generated text. **Fork with
summary...** is secondary and explicitly enters the existing summary workflow.
Composer text must not silently change the meaning of a normal fork click.

### Completed-turn safety

Clone and Fork after retain only completed provider turns. While the current
response is still being written, YA must either disable the action with clear
copy or wait in a cancellable state. It must not copy a partial response or
silently fall back to a before-turn boundary.

Clone does not consume, move, or submit the source composer draft. A clone
opened cold starts with an empty target composer; the source draft remains
owned by the source session.

## Confirmed Incidents — 2026-08-01

The investigation used session
`019fbc3b-93a6-7cc2-a557-aaedca534c6e` in project `yepanywhere`. Read-only
session/provider requests reported provider `codex`, model `gpt-5.6-sol`, and
`supportsForkSession: true`. The code/session inspection after the reported UI
failures was read-only and issued no additional fork or clone request.

The originating session retains two supplied screenshots (not tracked with
this repository):

- `Screenshot 2026-08-01 at 9.44.30 AM.png`
  — the only visible fork button on the first user prompt reports
  `No earlier loaded turn to fork from`.
- `Screenshot 2026-08-01 at 9.57.55 AM-sd.png`
  — after a second real user turn exists, fork-before reports
  `Codex fork anchor codex-112-2026-08-01T07:38:02.999Z was not found in
  source thread`.

### 1 — the visible fork icon cannot fork the first turn

The action rendered beside a user prompt is only `onForkBefore`. It is not a
generic fork or clone action. `SessionPage.forkBeforeUserMessage` walks
backwards for a previous normalized user/assistant message and fails when none
exists.

For the first user request, that failure is inevitable. The UI nevertheless
renders the action because gating checks only provider capability, not boundary
availability. The icon therefore advertises an operation that cannot succeed.

### 2 — Fork after is unreachable in a one-turn session

Fork after exists only in the right-scroll turn-notch context menu. Normal turn
navigation uses `MIN_NAV_ANCHORS = 2`, and `measureLayout` returns `null` below
that threshold. A one-turn session therefore has neither a turn rail nor its
Fork after action.

This is why adding another turn appears to be required even though the backend
full-fork primitive has no such requirement. Search mode's separate one-anchor
measurement exception does not make Fork after a discoverable normal action.

### 3 — Codex display ids are not provider fork anchors

Once the second user turn existed, fork-before selected the preceding final
assistant message id:

```text
codex-112-2026-08-01T07:38:02.999Z
```

That id is synthesized by rollout normalization as
`codex-${position}-${timestamp}`. It is a YA display/dedup identity, not a
Codex app-server turn or item id.

The corresponding durable rollout row contains distinct provider identities:

```text
item id: msg_067bcc99875d3a32016a6da24b9dd48191a067efd5f5989839
turn id: 019fbc3b-9448-7481-93c4-d0618560481e
```

`CodexProvider.findCodexForkAnchor` searches app-server `turn.id`, `item.id`,
and `clientId` candidates. It cannot find the synthesized display id, producing
the raw error shown in the screenshot.

This is an identity-boundary bug: a renderer identity crossed into a provider
control API as if it were a provider resume handle. Do not fix it by replacing
YA-visible session ids or general message identities with provider ids. Preserve
the two identities and resolve between them at the server/provider boundary.

### 4 — client Fork after mistakes tool results for human turns

`SessionPage.resolveForkAfterAnchor` stops at the next message whose normalized
`type` is `user`. Claude and Codex tool results also use the user role.

Replaying that resolver against the read-only response for the reported session
produced:

- selected real user request: normalized message 0;
- alleged next user turn: normalized message 4, a `tool_result`;
- alleged completed boundary: normalized message 3, the first tool call; and
- actual next human-authored request: normalized message 108.

The resolver would therefore slice inside the first provider turn. Codex
deliberately rejects an item anchor before the end of its turn because rollback
can remove only whole completed turns. The existing
`codexUserTurnProvenance`/turn-grouping rules already distinguish real input
from user-role provider context; fork code bypasses them.

### 5 — Clone still exists as an API but not as a product action

Two complete-copy paths coexist:

- `POST .../fork` accepts an optional `upToMessageId`; omitting it is explicitly
  a full-transcript provider fork.
- `POST .../clone` and `api.cloneSession` still perform storage cloning for
  Claude/Codex/Codex OSS and remain used by `/btw`.

The old session-menu Clone action was removed in commit `299847ea` after it was
observed to fail silently. Its i18n strings and API survived, but no replacement
full-copy UI was added.

The provider-native full fork is the correct user-facing mechanism. The raw
storage clone should not become a second public meaning of Clone.

### 6 — restart Fork is not a passive clone

The Handoff dialog can expose a Fork mode, but that route resumes the target
with `Continue from this fork point.` and retires the old process after
replacement activity. Opening the dialog also starts handoff-draft preparation.

That is a replacement/restart workflow. It must not be documented or presented
as the workaround for "copy this session and leave the original alone."

### 7 — errors expose mechanics instead of recovery

The first-turn failure reports an internal loaded-anchor condition. The Codex
failure exposes a normalized id and app-server lookup error. Neither tells the
user which action is available or whether their original session changed.

Fork failures must state the product result: no new session was created, the
source is unchanged, and the user may retry after the response completes or use
Clone where appropriate. Provider details belong in structured logs and an
optional diagnostic detail, not the primary toast.

## Architecture Direction

### Server owns user intent and boundary resolution

Stop making the client derive a provider fork pointer by scanning normalized
messages. The client should send a user-level intent:

```ts
type SessionForkIntent =
  | { kind: "clone-latest-complete" }
  | { kind: "before-user-turn"; sourceMessageId: string }
  | { kind: "after-user-turn"; sourceMessageId: string };
```

This is the approved domain model. The proposed wire spelling is
`forkKind` plus `sourceMessageId`; it remains behind the compatibility approval
gate below and can be renamed during implementation without changing the three
meanings.

The server resolves the selected normalized user message through the owning
reader's real-user-turn provenance, finds the requested completed boundary,
and passes a provider-native fork boundary to the adapter:

- Claude: durable transcript UUID accepted by SDK `forkSession`;
- Codex: app-server turn id plus whole-turn rollback count, with item ids used
  only when they name a completed turn boundary;
- Pi: durable Pi entry id on the retained branch; and
- full Clone: no slice boundary after the latest-complete safety check.

YA render ids, React keys, positional normalized ids, provider item ids, and
provider turn ids remain separate typed concepts. A conversion must be explicit
and tested; a plain `string` passed across all layers recreates this incident.

### Preserve provider boundary identity on the server

Extract the existing route-local `resolveForkAfterBoundary` logic into one
server-owned completed-turn resolver and extend it for before-turn and latest-
complete intents. The resolver returns both the YA display boundary used for
placement/diagnostics and a typed provider boundary used for the write:

```ts
type ProviderForkBoundary =
  | { kind: "full" }
  | { kind: "message"; provider: "claude"; messageId: string }
  | { kind: "turn"; provider: "codex"; turnId: string }
  | { kind: "entry"; provider: "pi"; entryId: string };
```

This is also conceptual rather than a required public type name. The important
constraint is that provider ids stay server-side and cannot be substituted for
YA session ids or renderer ids.

For Codex, build a reader-owned association between each paired human user turn
and its completed provider turn id. Use persisted user-turn provenance plus the
turn lifecycle/response metadata, then confirm the selected id against
app-server `thread/read`. Pass the resulting turn id to the Codex adapter so it
can calculate whole-turn rollback directly. Do not send provider ids through
the browser, match prompts by text, or infer a human turn from a user-role row.

### Keep one orchestration result

Every successful cold Clone/Fork should return the same YA-level result:

- canonical new YA session id;
- source/parent YA session id;
- provider and project id;
- resolved boundary kind and selected source turn for diagnostics;
- title; and
- no process id, because no target process starts until the user sends.

Fork-with-summary may build on that primitive and then start its explicit
summary turn. Restart Fork may build on it and then start its explicit
continuation turn. Those are downstream workflows, not alternate definitions
of the copy operation.

## Implementation Plan

### 1 — freeze the reported short-session and Codex failures

- Add a one-real-turn client fixture proving the first prompt does not expose a
  dead Fork before action and does expose an operable Fork after path.
- Add a two-turn Codex fixture modeled on the reported rollout: positional
  assistant display id, provider item/turn ids, several tool calls/results, and
  a second paired human prompt.
- Prove the current resolver's tool-result mistake before replacing it.
- Add a provider test proving a normalized `codex-N-timestamp` id is not a
  valid app-server pointer and the corrected path uses the actual completed
  turn id.
- Attach the supplied screenshots and exact errors if this plan moves to a
  tracked issue/archive; tests should assert behavior, not the accidental raw
  error copy.

### 2 — record the approved Clone, Fork, and Handoff contract

- Treat the approved product decisions above as fixed for the first
  implementation.
- Keep the existing words and effects of Restart/Handoff separate even when it
  reuses the same provider primitive internally.
- Re-open product review only if provider behavior makes one of the approved
  outcomes impossible; do not silently substitute a summary or continuation.

### 3 — record the hosted-client fork contract

Classification: **optional**. Clone/Fork is provider-dependent and can be
honestly hidden while the rest of session use remains intact.

Required corpus on 2026-08-01:

| Stable release | Released | Receipt |
| --- | --- | --- |
| `v0.7.0` (`c40735b8`) | 2026-07-25 | Latest stable; inside the preceding 14 days |
| `v0.6.2` (`a9af64ee`) | 2026-07-11 | Second-latest stable; included even though older than 14 days |

Both releases provide
`POST /api/projects/:projectId/sessions/:sessionId/fork` with optional
`upToMessageId`, and both expose provider-level `supportsForkSession`. Neither
advertises a server capability for resolving a human-turn intent, and both
contain the client-side resolver/control failures recorded above.

Approved compatibility contract:

- Add transitional `/api/version` capability `session-fork-turn-intents`.
- Add `sessions` as a capability-registry area and record the actual first
  release containing the contract when that release is chosen. Set
  `reviewAfter` to 2026-09-01; remove the client gate only after the optional
  support corpus contains no server without it and the Maintainer approves.
  Keep server advertisement until no maintained client branches on it.
- Under that capability, the existing `/fork` route accepts `forkKind` with
  `clone-latest-complete`, `before-user-turn`, or `after-user-turn`, plus
  `sourceMessageId` for the two turn-relative forms.
- Reject a request that mixes the new intent fields with legacy
  `upToMessageId`.
- Keep parsing the existing legacy body shape so an old client does not fail
  merely because the route changed. Do not add compatibility code that tries
  to reproduce or repair its known-broken client-side turn selection; the
  server still validates the exact legacy anchor and may reject it.
- Do not broaden provider `supportsForkSession`; it continues to mean only that
  the selected provider implements the primitive.
- Do not bump `remoteCompatibilityLevel`; this is one narrow optional feature
  with an exact capability.

New-client/older-server fallback:

- Never send `forkKind` or `sourceMessageId` when
  `session-fork-turn-intents` is absent.
- Hide the entire unified Clone/direct-Fork surface when the capability is
  absent and make no `/fork` request. Upgrading the server is the fallback; do
  not emulate the known-broken client-side boundary scan or special-case the
  older route's full-fork behavior.
- When the capability is present, still require provider
  `supportsForkSession === true`. Hide the actions and make no request when
  provider support is absent or unknown.

Old-client/new-server behavior:

- Preserve empty-body and `{ upToMessageId }` request handling.
- Apply completed-turn safety only to the explicit new
  `clone-latest-complete` intent. This avoids silently changing the legacy
  empty-body meaning for existing clients and internal callers.
- Do not promise that an old client's broken per-turn affordance becomes
  usable. Compatibility here prevents protocol misinterpretation; it does not
  preserve accidental UI behavior.
- Response fields used by older clients remain unchanged. New diagnostics may
  be additive, but the new client must need only the existing target session
  id/project/provider/title fields to navigate.

Recorded decision:

> Releases `v0.7.0` and `v0.6.2` lack `forkKind`/`sourceMessageId` and
> `session-fork-turn-intents`. Add that transitional capability to gate the new
> server-resolved fields. Without it, hide unified Clone/direct Fork and make
> no request. Existing `supportsForkSession`, legacy request bodies, response
> fields, and remote compatibility level retain their meanings; no effort is
> spent preserving the known-broken old per-turn UI.

### 4 — centralize completed-turn boundary resolution

- Create one server-side resolver for latest complete, before real user turn,
  and after real user turn.
- Reuse provider/user-turn provenance; tool results, compact summaries,
  injected context, queue echoes, and synthetic rows must not open a new human
  turn.
- Return typed YA/source and provider boundary evidence for diagnostics.
- Reject active/incomplete boundaries before invoking a provider.
- Remove client scans that choose `upToMessageId` from neighboring normalized
  rows.

### 5 — repair Codex fork addressability

- Sync/verify the pinned Codex reference before source changes and inspect the
  matching app-server `thread/read`, `thread/fork`, and rollback identities.
- The 2026-08-01 preflight found the optional local checkout at
  `rust-v0.144.1` while `package.json` expects `rust-v0.145.0`; run
  `pnpm references:sync` only after the Maintainer says to proceed, then require
  `pnpm references:check` to pass before relying on upstream source receipts.
- Preserve provider item/turn identity alongside normalized messages or resolve
  it from the durable rollout on the server; do not replace render UUIDs.
- Prefer Codex's direct completed-turn id as the boundary. Use rollback count
  only for trailing whole turns.
- Cover ordinary text-only turns, tool-heavy turns, compaction/interruption
  rows, and unknown/missing provider ids.
- Replace raw provider errors with a stable action-level failure plus structured
  diagnostic logging.

### 6 — restore direct Clone in session-header chrome

- Add an optional header-only Clone handler to `SessionMenu`.
- Gate it on both `session-fork-turn-intents` and provider
  `supportsForkSession`, and use the latest-complete intent.
- Show a visible pending state and prevent duplicate activation.
- On success, navigate to the cold target and preserve parent lineage,
  provider/model/workstream, sandbox state, and title metadata.
- Title the target `Clone: <source>` without repeatedly stacking the prefix.
- On failure, leave the source and its draft untouched and show an actionable
  message.
- Put new component-owned styles in co-located CSS Modules. Do not grow a
  frozen global stylesheet to add the menu or pending state.

### 7 — make per-turn Fork operable without the turn rail

- Replace the unlabeled fork-before-only prompt action with one **Fork from this
  turn** button that opens an explicit menu/sheet from the prompt's normal
  action surface.
- Offer only valid choices for that turn: after on a completed first turn;
  before/after on later completed turns.
- Keep the turn-notch menu as a shortcut backed by the same handlers.
- Make touch targets and labels usable at 375 px; long-pressing a tiny rail
  notch cannot be the only mobile path.
- Use **Before this turn**, **After this turn**, and **After with summary...**
  labels. The first two are message-less; the last is visually secondary and
  enters the existing summary flow before any composer state is consumed.

### 8 — converge internal clone and replacement consumers

- Move `/btw` to the canonical full-fork primitive where the provider supports
  it; document any Codex OSS storage-clone exception explicitly.
- Keep or deprecate the legacy `/clone` route according to remaining internal
  consumers, but do not expose it as a second public Clone implementation.
- Make Restart/Handoff copy explicit that Fork starts a continuation and
  retires the source process.
- Ensure retitle, recap, and fork-summary helpers use the same typed provider
  boundary machinery without changing their archived-helper lifecycle.

### 9 — prove the unified fork surface and close the contracts

- Add client component tests for header Clone, one-turn Fork after, later-turn
  Fork before/after, active-turn disabled state, draft preservation, and touch
  access.
- Add server/provider tests for full and sliced Claude/Codex/Pi forks, including
  the reported Codex fixture and tool-result provenance.
- Add released-server compatibility fixtures for the chosen gate/fallback.
- Run warning-free lint, typecheck, focused/full tests, i18n scan, console scan,
  and capability audit as applicable.
- Capture and inspect the final header and per-turn actions at 1920x1080 and
  375x812, including a one-turn session and a visible recoverable failure.
- Update the owning topics from "known broken" to the verified contract only
  after provider-level proof passes.

## Isolated Real-Provider Validation

Real validation is required after all deterministic tests pass. It must not use
the Maintainer's running server, current YA data directory, or an existing
project/session as a source.

### Temporary YA server profile

- Create one explicit `mktemp -d` root and a separate empty project directory
  within it.
- Start the source checkout on a free three-port block with
  `HOST=127.0.0.1`, `YEP_DATA_DIR=<temp-root>/ya`,
  `ENABLED_PROVIDERS=claude,codex`,
  `VOICE_INPUT=false`, `AUTH_DISABLED=true`, `OPEN_BROWSER=false`, and file
  logging enabled. Do not use port 3400.
- Do not override `CLAUDE_CONFIG_DIR` or `CODEX_HOME`: the real CLIs need their
  existing authentication. The unique temporary cwd keeps the smoke sessions
  scoped to one disposable project even though provider-native transcripts are
  written to the normal authenticated stores.
- Never inspect, fork, modify, archive, or delete unrelated provider sessions.
  Record every created YA/provider id. Retain provider transcripts for review;
  do not delete them as automatic cleanup.
- Archive server logs, API assertion output, and browser captures under
  `.artifacts/ui-testing/2026-08-01-fork-clone/` before removing only the
  validated temporary YA data/project directories. Validate the exact
  `mktemp` root before any cleanup operation.

### Bounded model and prompt budget

- Claude: `haiku`. If the live catalog does not offer Haiku, stop the Claude
  smoke rather than silently selecting Sonnet/Opus.
- Codex: `gpt-5.6-luna` with low reasoning. If unavailable, use
  `gpt-5.4-mini` with low reasoning; if neither is available, stop the Codex
  smoke rather than selecting Sol or another frontier model.
- Use a tiny marker file and short deterministic prompts. The first source turn
  must read the file, producing a real tool call/result; the second source turn
  is text-only.
- Budget at most three successful model turns per provider: two on the source
  and one continuation from a cold fork. Permit at most one retry per provider
  for a clearly transient transport/capacity failure. Fork/Clone operations
  themselves send no model turn.
- Do not run Fork with summary in the paid-provider smoke. Its resolver and UI
  integration are covered deterministically; summary generation is unchanged
  and would add unrelated model turns.

### End-to-end matrix for both Claude and Codex

1. Start a real source session in the temporary project with the tool-forcing
   marker prompt and wait for a completed response.
2. From the first prompt's browser action, verify **After this turn** is
   available and **Before this turn** is absent. Create the cold fork.
3. Assert through session/process APIs and rendered history that the target has
   a distinct canonical YA id, no live process, no synthetic continuation,
   the complete tool call/result/final response, and no source draft mutation.
4. Resume that cold target with one short context question and verify the real
   provider retained the marker context.
5. Return to the untouched source, send the second short turn, then exercise
   **Before this turn** and **After this turn**. Verify their retained prefixes
   exactly; in particular, the before-second and after-first boundaries match.
6. Use header **Clone** after the second response. Verify both turns are
   retained, the new composer is empty, no process starts, parent lineage and
   settings persist, and the source remains byte-for-byte unchanged at the
   provider transcript level.
7. Capture and inspect the header and prompt menus at 1920x1080 and 375x812.
   Include the one-turn state, later-turn before/after state, pending/disabled
   state, and a recoverable failure toast.
8. Review browser/toast output for raw provider-id leakage. Review server logs
   for unexpected requests, warnings, duplicate forks, or background processes
   left alive; typed provider ids are appropriate in structured diagnostics.

The real smoke passes only when both providers complete the same matrix. A
provider/auth/catalog failure is reported as an environmental block, not
silently replaced with a fixture result.

## Current Approval Gate

This documentation commit authorizes no implementation and no paid-provider
calls. The product and compatibility decisions are approved; an explicit
**proceed** authorizes implementation, the bounded real-provider spend, and the
isolated-profile validation above. Any material change to those boundaries
returns here for review before code is changed.

## Acceptance Gates

- A session with one real user request and one completed assistant response can
  be cloned from the header without adding a turn or changing the source.
- The same one-turn session exposes Fork after without requiring a hidden rail
  or a second request.
- Fork before the second real user request retains the complete first turn,
  including every tool call/result and final assistant text.
- Fork after a tool-heavy turn retains that complete turn and no later real
  turn.
- No positional `codex-N-timestamp` display id is sent to app-server as a turn
  or item id.
- User-role tool results and injected provider context never count as the next
  human turn.
- Clone/Fork remains absent when either the server capability or a true
  provider fork primitive is missing, and makes no unsupported older-server
  request.
- Active-response behavior is explicit and never creates a partial fork.
- Clone, Fork, Handoff, and Fork with summary have distinct visible copy and
  observable effects.
- Failures confirm that the source is unchanged and do not expose raw provider
  ids as the primary explanation.

## Non-goals

- Arbitrary item-level Codex forks inside a turn; Codex remains whole-turn
  only.
- Cross-provider handoff or forged transcript replay.
- Provider session-tree navigation or branch merge UI.
- Making the legacy storage-copy `/clone` route the canonical fork API.
- Redesigning recap/fork-summary generation beyond separating it from the
  ordinary Clone/Fork defaults.
