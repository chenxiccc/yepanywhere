# Durable Session Reactivation Settings

Topic: session-reactivation
Topic: session-defaults
Topic: reload-safe-provider-runtimes

Status: Implemented 2026-08-03 in `c29bf7e2`. Defect verified 2026-08-03; it
predates the current harsh-review range.

## Observed defect

After an idle provider process is reaped, choosing **Activate** can change an
existing Codex session from **Bypass** to **Ask**. The same class of cold launch
can also lose the session's model or thinking/effort selection when the caller
does not happen to resend browser-local state.

The direct next-message path from the same browser usually sends its locally
stored permission, model, and thinking values, which masks the defect. The
message-less Reactivate request sends no launch options. Its server route
restores `provider`, `requestedModel`, and `executor` from session metadata, but
builds permission and thinking options from the empty request body. The
supervisor consequently applies its absent-mode default, **Ask**, and the
returned live-process mode then overwrites the browser's prior **Bypass**
selection. A different browser or device cannot recover settings that existed
only in the original browser's storage.

The Codex-native reload host is a separate lifecycle. It preserves a live
runtime's reattach snapshot across a Hono reload. It cannot preserve settings
after the provider runtime itself has been reaped and a new runtime must be
launched.

Relevant contracts:

- [Session reactivation](../../topics/session-reactivation.md)
- [Session defaults](../../topics/session-defaults.md)
- [Reload-safe provider runtimes](../../topics/reload-safe-provider-runtimes.md)
- `packages/server/src/routes/sessions.ts` — Reactivate and other cold-launch
  routes
- `packages/server/src/metadata/SessionMetadataService.ts` — durable YA session
  launch metadata
- `packages/client/src/pages/SessionPage.tsx` — Activate and live-mode adoption

## Required invariant

A process lifetime is not a settings lifetime. Every replacement process for
an existing YA session must start with the session's last successfully applied
permission mode, requested model, thinking mode, effort, and related
provider-launch settings unless the triggering request explicitly supplies a
new value.

Missing launch fields mean **inherit the durable per-session value**, not
**restore a global default**. Legacy sessions with no durable value retain the
current conservative defaults; in particular, absence must never be
interpreted as an instruction to grant Bypass.

## Implementation plan

### 1 — define one durable session launch-settings record

Extend the server-owned session metadata with a versioned effective launch
configuration. Reuse existing fields such as `requestedModel` through an
explicit migration or compatibility projection rather than creating two
competing sources of truth.

The record must distinguish an absent legacy value from an explicitly selected
value. Persist Bypass only after YA has successfully applied that explicit
selection to the session. Keep display-only preferences such as **Show
thinking** out of the provider launch record.

### 2 — update settings only at successful policy boundaries

Persist the effective record after a successful new launch, resume/reactivate,
model or thinking change, and permission-mode change. Do not commit a requested
setting before the provider or process accepts it. Use a monotonic version (or
the existing permission `modeVersion` where its scope is sufficient) so a
stale client response cannot overwrite a newer applied value.

### 3 — resolve every cold launch through one helper

Centralize launch-setting resolution with this precedence:

1. explicit, validated request value;
2. durable per-session effective value;
3. legacy launch metadata where applicable;
4. the existing global/provider default.

Use that helper for message-less Reactivate, direct message resume, recovered
queue launch, recap-triggered launch, restart/handoff, and provider-host
recovery. Keep provider capability normalization at the established provider
boundary; inheriting an unsupported stale option must not bypass validation.

### 4 — make Activate adopt, not redefine, session policy

Return the restored effective configuration from Reactivate and let the client
adopt it as authoritative live-process state. The client must not clear or
replace a durable value merely because an older server omits a new response
field. Preserve supported-server compatibility with an explicit capability or
the existing safe legacy behavior before adding any new client dependency.

### 5 — cover process death and cross-client recovery

Add focused tests for:

- Bypass -> idle reap -> Activate remains Bypass;
- Ask and Plan remain unchanged through the same lifecycle;
- model, thinking mode, and effort survive process reap and Reactivate;
- an explicit Reactivate override wins and becomes the new durable value;
- a legacy session with no saved mode uses Ask rather than Bypass;
- a second browser/device receives the server-owned effective configuration;
- direct message resume, recovered patient work, recap launch, and
  restart/handoff use the same precedence;
- rejected setting changes do not alter the durable record; and
- Codex-native and shared-host Hono reload reattach preserve their live
  snapshots without needlessly rewriting the durable record.

## Implementation evidence

`SessionMetadataService` now owns one schema-v1 effective launch-settings
snapshot with a monotonic revision. It records permission mode, the exact
requested model token (including `default`), service tier, thinking mode, and
effort. Semantically identical snapshots do not rewrite metadata or advance
the revision, and the old `requestedModel` field remains a legacy projection
rather than a competing authority.

`Supervisor` resolves every cold launch through explicit request values,
durable settings, legacy metadata, then conservative defaults. It writes the
complete effective snapshot only after process creation or a live setting
change succeeds; a rejected provider change and a failed launch leave the
durable record unchanged. Direct resume, message-less Reactivate, recovered
queue work, restart/handoff, and transcript fork all use that resolution path.
Provider-host reattach remains a live-runtime path and keeps its existing
in-memory snapshot instead of manufacturing a cold launch.

Activate already makes the returned process id authoritative: the client
fetches `ProcessInfo`, adopts its live model/thinking/effort configuration, and
receives permission-mode changes through the existing process stream. That
channel also covers another browser after activation, so implementation did
not add a Reactivate response field or make a new client depend on a newer
server contract.

Focused server coverage exercises Ask, Plan, and Bypass across process death;
exact model, service-tier, thinking, and effort restoration; explicit
overrides; conservative legacy fallback; rejected changes; direct resume;
recovered queue work; and restart/fork inheritance. The implementation also
keeps live-runtime reattach snapshots separate from the cold-launch record.

## Acceptance

On a Codex session set to Bypass with a non-default model and thinking/effort
choice, allow the provider process to be reaped for inactivity, reload or open
the session from another client, and choose **Activate**. Before any user turn,
the reactivated process and composer must report the same effective permission,
model, thinking, and effort settings. Repeating the lifecycle through each
server-owned cold-launch path must produce the same result, while a legacy
session with no saved policy continues to start conservatively.
