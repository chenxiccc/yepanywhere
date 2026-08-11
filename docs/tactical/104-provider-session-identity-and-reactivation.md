# Make Resume and Reactivation Use Native Session Identity

> Resolve an existing session's provider, transcript project, and working
> directory from durable or provider-native evidence, then report resume
> success only after the provider has actually attached to that session.

Status: planned. The three source defects remain open; this document
consolidates their remediation and acceptance boundary before implementation.

Related contracts and plans:

- [`topics/session-reactivation.md`](../../topics/session-reactivation.md)
- [`topics/agent-working-directory-tracking.md`](../../topics/agent-working-directory-tracking.md)
- [`topics/session-ownership.md`](../../topics/session-ownership.md)
- [`topics/session-liveness.md`](../../topics/session-liveness.md)
- [`topics/provider-abstraction.md`](../../topics/provider-abstraction.md)
- [`093-provider-session-reconciliation.md`](093-provider-session-reconciliation.md)

Source defects:

- [`gaps/provider-resume-readiness.md`](../../gaps/provider-resume-readiness.md)
- [`gaps/reactivate-provider-resolution.md`](../../gaps/reactivate-provider-resolution.md)
- [`gaps/session-transcript-project-from-launch-cwd.md`](../../gaps/session-transcript-project-from-launch-cwd.md)

## Current fault

Existing-session actions currently reconstruct one identity from three
different kinds of evidence:

- The resume route can recover a provider from native readers, but derives its
  launch directory from the project in the request URL unless durable sandbox
  metadata overrides it.
- The reactivate route uses persisted YA provider metadata and otherwise falls
  through to the selected project's default provider. An externally created
  native session has no YA launch record, so this fallback can start the wrong
  backend.
- Project reclassification records the live process's project as the transcript
  project when no earlier pointer exists. A process project is its launch or
  effective working directory; it is not evidence of where a provider stores
  the transcript.

Resume has a second, independent timing fault. The route returns
`resume.outcome: "started"` after the Supervisor creates a `Process`. Providers
whose native load occurs when their session iterator is first consumed can
reject the session id after that response. Process existence therefore proves
YA work admission, not successful provider attachment.

## Identity contract

Treat provider, transcript project, and working project as separate facts:

- **Provider identity** selects the native runtime and reader family.
- **Transcript project** is the canonical provider-native location from which
  YA reads the existing transcript. Codex derives it from `session_meta.cwd`;
  other provider resolvers use their equivalent exact native evidence.
- **Working project** is the directory in which a resumed agent runs and the UI
  resolves relative project actions. A durable user reclassification may set
  it independently of the transcript project.

One server resolver should return those facts together for an existing session
id. It uses this precedence:

1. an explicit, validated provider override expresses current user intent;
2. persisted YA session metadata supplies provider and any durable working
   project;
3. exact provider-native discovery supplies provider and transcript project;
4. an unresolved existing session fails without starting a project-default
   provider.

The request URL only identifies the route and a candidate UI project. It may
match the resolved identity, but it cannot establish provider or transcript
location. A durable working-project override wins for launch cwd; otherwise
the provider-native transcript project supplies the launch cwd. A live
process's project never supplies transcript location.

Tactical 093 may eventually provide the retained exact native row used by this
resolver. Until that catalog is wired into routes, the resolver may use bounded
provider-reader lookup. Route correctness must not depend on completion of the
larger catalog migration, and the two paths must converge on the same result
shape rather than becoming competing identity rules.

## Attachment-readiness contract

The shared Process/provider lifecycle needs an explicit native-attachment
settlement distinct from process construction, queue admission, first output,
and completion of a model turn. A provider settles it successfully after its
resume/load protocol has accepted the requested native session. It settles it
with the provider error when the native id is absent, rejected, or cannot be
loaded.

The resume endpoint must not describe attachment as started while this
settlement is already known to have failed. Implementation must choose and
compatibility-review one public behavior:

- await bounded attachment settlement before returning `started`, returning an
  actionable non-success response on rejection; or
- return an explicit initializing outcome and publish the later attached or
  failed result through an already-gated lifecycle surface.

Do not infer attachment from the first assistant delta: a valid native load may
be idle before producing output, and a failed load should not require a model
turn to become visible. Message-less reactivation may construct an idle process
without eagerly touching a provider. Its response must state only what that
operation establishes unless the provider is deliberately initialized and the
same attachment settlement is awaited.

## Recommended implementation order

### 1 — centralize existing-session identity resolution

Extract one route-independent resolver over persisted metadata and exact native
readers. Return provider, transcript project, durable working project, evidence
source, and an explicit unresolved result. Cover external sessions and
conflicting request/project defaults before changing route behavior.

### 2 — stop writing launch cwd as transcript location

Use the resolver in project reclassification. Preserve a known provider-native
transcript project even when a live process was launched elsewhere. Reject a
move whose existing-session identity cannot be established rather than
persisting the request project as a guess.

### 3 — align resume and reactivation launch identity

Use the same resolution result in resume and reactivate. Keep explicit provider
overrides and durable working-project reclassification, but remove project
default as an implicit fallback for an existing session. Ensure remote sync and
sandbox path derivation consume the resolved working directory.

### 4 — add provider attachment settlement

Add one provider-neutral settlement to the Process/Supervisor lifecycle and
wire native resume/load implementations to it. Prove success, rejection,
provider startup failure, cancellation, and teardown all settle exactly once
without leaking a waiter or keeping an idle process alive.

### 5 — compatibility-review the resume result

Before changing route response timing or adding an initializing/failed state,
inspect the stable server corpus required by `topics/server-capabilities.md`.
Name the exact response field or capability gate and the behavior of older
clients and servers. Keep queued admission distinct from provider attachment.

### 6 — exercise the combined boundary

Add route and lifecycle coverage for every provider with native sessions. At
minimum, cover an external Grok session under a Claude-default project, a Codex
rollout reached through the wrong project URL, a deliberate durable working
project override, a live process whose launch cwd differs from transcript cwd,
and a native load rejection before a response claims attachment.

## Acceptance

- An unqualified reactivate of an externally created session selects the
  provider identified by exact native evidence, never the project's default.
- Resuming through a stale or incorrect project URL launches from the durable
  working project when one exists, otherwise from the native transcript
  project.
- Moving a session records its provider-native transcript project even when a
  live process was launched from another directory.
- Explicit provider overrides remain possible and visible as user intent;
  implicit unresolved identity fails without starting another provider.
- A rejected or missing native session id cannot produce a response that says
  attachment started successfully.
- Existing YA-launched sessions with consistent persisted identity retain their
  current provider, working directory, sandbox, remote-sync, and queue behavior.
- Resolution and attachment failure paths leave no orphan process, pending
  waiter, or repeating provider scan.
