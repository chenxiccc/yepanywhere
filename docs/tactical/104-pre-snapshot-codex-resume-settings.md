# Recover Pre-Snapshot Codex Resume Settings

> Preserve the effective launch behavior of Codex sessions created before
> `SessionMetadata.effectiveLaunchSettings` by recovering their latest durable
> provider context at the first subsequent cold launch.

Status: **implemented and verified** (2026-08-11).

## Motivation

Server-owned per-session launch snapshots landed on 2026-08-03. Sessions that
predate that field are valid history, not a different product class, but a
message-less activation currently has no durable permission, thinking, or
effort record for them. It therefore falls through to conservative process
defaults even when the Codex rollout still records the settings used by the
latest turn.

The older send-to-resume path masked this gap because the browser supplied its
best-effort per-session permission and global thinking selections with the
first message. Message-less activation made the server fallback visible. The
repair is a compatibility recovery path, not a new session-default policy.

## Observable contract

A cold launch resolves each setting in this order:

1. an explicit, validated launch request;
2. the complete `effectiveLaunchSettings` snapshot, including intentional
   provider-default/null values;
3. pre-snapshot YA model metadata where it exists, then the latest applicable
   Codex `turn_context` evidence;
4. the existing conservative server/provider fallback for anything still
   unknown.

Recovery is lazy. Merely listing, viewing, or indexing a session does not write
metadata. At the first successful cold launch, the complete settings actually
accepted by the provider become authoritative and are persisted through the
normal `effectiveLaunchSettings` writer. A rejected or failed launch persists
nothing. Later launches use that snapshot and do not reinterpret the
transcript.

`Show thinking` remains browser display policy and is not recovered into
provider launch state. Codex transcripts do not currently provide a YA service
tier token, so service tier retains its existing fallback.

## Codex recovery mapping

Use the last valid `turn_context`, because model, policy, and effort may change
between turns.

| Transcript evidence | Recovered YA setting |
| --- | --- |
| non-empty `model` | exact requested model token |
| `approval_policy: never` + `sandbox_policy.type: danger-full-access` | Bypass |
| `approval_policy: on-request` + `sandbox_policy.type: read-only` | Plan |
| `on-request` + `workspace-write`, incomplete, or unfamiliar policy pair | Ask |
| `effort: none` | thinking disabled |
| supported `low` / `medium` / `high` / `xhigh` / `max` effort | adaptive summarized thinking with that effort |
| absent or unsupported effort | no thinking inference; retain the normal fallback |

Ask and Accept Edits intentionally share Codex's native
`on-request`/workspace-write pair, so the transcript cannot distinguish them.
Ask is the safe recovery. No incomplete or unfamiliar evidence may infer
Bypass.

## Implementation sequence

### 1 — retain Codex effort in the rollout schema

Add the optional `turn_context.effort` field from the pinned Codex protocol to
YA's permissive rollout schema. Keep unfamiliar string values parseable so a
future Codex value does not invalidate the surrounding context.

### 2 — recover the latest Codex launch context

Teach `CodexSessionReader` to stream a rollout to its latest turn context and
return a bounded launch-settings candidate. Reuse the summary stream so the
compatibility read does not retain the complete transcript in the entry cache.

### 3 — resolve pre-snapshot cold launches

Give `Supervisor` an optional provider-neutral recovery callback. Consult it
only when no complete launch snapshot exists, merge recovered values below
explicit and durable state, and retain existing YA requested-model metadata.
Wire the app callback only for Codex/Codex OSS readers. Recovery failure is
best-effort and falls through to existing conservative defaults rather than
blocking a resume.

### 4 — make the successful launch authoritative

Keep the existing successful-session boundary as the only persistence point.
Assert that recovered and fallback values used by a successful provider launch
produce the complete revision-1 snapshot, while a failed launch leaves the
session without one. Assert that the next cold launch reads the snapshot rather
than the transcript.

### 5 — pin compatibility and ambiguity tests

Cover latest-context selection, exact Bypass and Plan recovery, ambiguous Ask,
disabled and supported thinking effort, unsupported effort fallback, explicit
and durable precedence, YA model-metadata precedence, successful persistence,
and failed-launch non-persistence.

### 6 — update the owning contracts

Update `topics/session-defaults.md`, `topics/session-reactivation.md`, and
`topics/codex-permission-mode.md` with the pre-snapshot recovery order,
ambiguity rule, and successful-launch authority boundary.

## Scope and compatibility

This is server-internal recovery. It adds no route, request field, response
field, event, capability, or client dependency, so mixed-version clients retain
their existing behavior. It creates no project-local state: the transcript is
read from the provider store and the successful snapshot is written only to YA
app metadata.

Relevant implementation surfaces:

- `packages/shared/src/codex-schema/session.ts`
- `packages/server/src/sessions/codex-reader.ts`
- `packages/server/src/supervisor/Supervisor.ts`
- `packages/server/src/app.ts`
- focused Codex reader and supervisor tests

## Acceptance criteria

- A pre-snapshot Codex session whose latest context is Bypass with `xhigh`
  resumes as Bypass with adaptive `xhigh` thinking and its latest model.
- A later turn context wins over the launch-time/first context.
- Ambiguous or malformed policy evidence never grants Bypass.
- Explicit launch values and complete snapshots remain authoritative.
- A successful recovered launch persists the exact effective process settings;
  a failed launch persists nothing.
- Subsequent cold launches use the new snapshot without reading transcript
  recovery again.
- No browsing or startup-wide migration rewrites historical sessions.

## Implementation outcome

The shared Codex schema now retains optional effort, and the Codex session
reader streams through the rollout to recover only the latest turn context.
Merged readers preserve configured root authority. Supervisor cold-launch
resolution consults that evidence only for incomplete pre-snapshot state; the
ordinary successful-start snapshot remains the sole write boundary.

Focused reader, merged-reader, and supervisor tests cover the recovery matrix,
precedence, bounded entry caching, successful persistence, failed-launch
non-persistence, and the transition from inferred evidence to authoritative
session history. The pinned Codex protocol artifacts and `rust-v0.147.0`
reference source remain aligned.
