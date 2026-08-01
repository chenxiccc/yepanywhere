# Session Fork And Clone Unification

Status: confirmed failure inventory and proposed implementation plan; no runtime
changes have been made from this tactical.

Topic: fork-from-turn
Topic: provider-fork-support
Topic: turn-rail-marker-layout

Related topics:
[session-context-actions](../../topics/session-context-actions.md),
[fork-from-turn](../../topics/fork-from-turn.md),
[provider-fork-support](../../topics/provider-fork-support.md),
[turn-rail-marker-layout](../../topics/turn-rail-marker-layout.md),
[provider-context-economics](../../topics/provider-context-economics.md),
[codex-user-turn-provenance](../../topics/codex-user-turn-provenance.md), and
[server-capabilities](../../topics/server-capabilities.md).

## Objective

Make a complete session copy obvious and dependable, make prefix forks work at
real user-turn boundaries on every advertised provider, and remove the current
requirement that a user understand YA's separate clone, fork, restart, turn
rail, and fork-summary implementations before choosing a safe action.

This is a repair and simplification pass, not a new conversation-tree product.
The existing provider `forkSession` primitive remains the foundation. The work
is to give it one trustworthy server-owned boundary model and a small, honest
set of user actions.

## Recommended Product Model

Use three distinct words for three distinct outcomes:

| Action | Meaning | Source session | New session |
| --- | --- | --- | --- |
| **Clone** | Copy through the latest completed response | Unchanged and still available | Opens cold with no new user turn |
| **Fork before/after** | Copy a prefix at an explicit completed-turn boundary | Unchanged and still available | Opens cold at the selected boundary |
| **Handoff** | Start a successor from bounded or generated context | May deliberately retire the source process | Starts with an explicit handoff turn |

Generated-summary fork is an explicit advanced form of **Fork after**, not the
default meaning of Clone and not an implicit interpretation of whatever text
happens to be in the composer.

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

This is a conceptual contract, not an approved wire shape. Before editing the
request contract, complete the compatibility review required by
`topics/server-capabilities.md` and the repository instructions.

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

### 2 — approve the Clone, Fork, and Handoff product contract

- Confirm direct header Clone, same-tab navigation by default, source session
  untouched, no generated message, and empty target composer.
- Confirm that normal per-turn Fork defaults to no summary and that generated
  summary is an explicit secondary action.
- Confirm active-turn behavior: disabled-until-complete is the recommended
  first implementation; a cancellable wait may follow if needed.
- Decide the target title prefix (`Clone:` versus the existing `Fork:`) without
  letting title wording block the correctness work.
- Keep session-list row Clone out of the first slice unless the header action
  proves insufficient.

### 3 — review the hosted-client fork contract

Before client/server contract edits:

- identify whether repaired per-turn fork is core or optional;
- inspect the required stable release corpus;
- define a new capability/request semantic rather than broadening an existing
  advertised meaning;
- state the exact older-server fallback; and
- obtain maintainer approval.

Recommended fallback: a hosted client may show direct full Clone only when the
older server's provider response already proves the existing full `/fork`
route. The new server-resolved before/after actions remain hidden when their
new capability is absent. Never send new intent fields speculatively.

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
- Gate it with `supportsForkSession` and the approved server capability.
- Invoke the full latest-complete fork intent, show a visible pending state,
  and prevent duplicate activation.
- On success, navigate to the cold target and preserve parent lineage,
  provider/model/workstream, sandbox state, and title metadata.
- On failure, leave the source and its draft untouched and show an actionable
  message.

### 7 — make per-turn Fork operable without the turn rail

- Replace the unlabeled fork-before-only prompt action with an explicit Fork
  menu or sheet available from the prompt's normal action surface.
- Offer only valid choices for that turn: after on a completed first turn;
  before/after on later completed turns.
- Keep the turn-notch menu as a shortcut backed by the same handlers.
- Make touch targets and labels usable at 375 px; long-pressing a tiny rail
  notch cannot be the only mobile path.
- Separate **Fork without summary** from **Fork with summary...** before any
  composer state is consumed.

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
- Clone/Fork remains absent when the provider has no true fork primitive and
  makes no unsupported request against an older server.
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
