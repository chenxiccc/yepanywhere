# Yacron

> Yacron is a proposed generally running, same-user local scheduler that lets
> agents and YA create, inspect, revise, and dispatch durable future prompts to
> existing or fresh YA sessions through the provider runtime.

Topic: yacron

Status: **proposal only; nothing is implemented (2026-08-27).**

Related:
[provider host API](provider-host-api.md),
[new-session agent tooling](new-session-agent-tooling.md),
[Routines](routines.md),
[session wake](session-wake.md), and
[vanilla defaults](vanilla-defaults.md).

## Simple baseline

Yacron is a fresh design, not an adapter around the existing `~/agents` `at/`
protocol. Its first version has five parts:

1. one scheduler inside the generally running YA provider host;
2. one `yacron` CLI used by agents and operators;
3. one service-owned store for entries and their run history;
4. one global config with an optional project-local override; and
5. an optional YA settings/list/editor UI over the same service API.

There is no separate yacron daemon in the first version. The provider host is
already the headless process that owns provider workers, queues, and resumes;
making it own the one deadline timer avoids another service lifecycle, socket,
authentication path, and handoff between scheduler and dispatcher.

The baseline deliberately excludes committed entry files, automatic import of
`at/`, use from outside YA, capability security, and early provider preparation.
Those remain useful follow-ups, not prerequisites for a trustworthy scheduler.

## Entry model

An active **entry** is only:

- an instruction;
- a `when` value;
- a target; and
- enabled/paused state plus service-assigned id and revision.

The service-assigned entry id is also the public **schedule id**; these are not
two objects or identifiers.

The first `when` grammar has two explicit forms:

- one RFC 3339 timestamp for a one-shot entry; or
- one five-field cron expression plus an IANA timezone for a recurring entry.

The service calculates and returns the next fire time whenever an entry is
created or revised. It does not infer recurrence from prompt prose.

The three target forms are:

- **current session** — resolved from `AGENTCTL_SESSION_ID` when scheduled;
- **existing session** — an explicit canonical YA session id; or
- **fresh session** — a project root plus the ordinary provider/model/launch
  choices needed to create a YA session whose first turn is the instruction.

A fresh-session target also stores an explicit project-session policy:

- **exclusive-project-session** waits until the project has no active/starting
  session and has remained free of session activity for its configured recent-
  activity timeout; or
- **concurrent-project-session** launches when due without that wait.

The simple default is exclusive with a 30-second recent-activity timeout,
overridable by global/project config and by the scheduling call. The resolved
mode and timeout are saved on the entry and shown everywhere; a later default
change cannot silently alter an already scheduled launch.

Current-session identity is resolved and stored at creation time. Dispatch
never guesses a provider session from the environment or filesystem. Existing
targets use canonical YA ids; provider-native resume ids remain private to the
provider host.

## CLI is the activation interface

The agent-facing binary is available on PATH when yacron tooling is enabled.
Its conceptual surface is:

```text
yacron schedule --at <timestamp> --prompt <instruction> --session current
yacron schedule --cron <expression> --timezone <zone> \
  --prompt <instruction> --new-session --project <root> \
  --exclusive-project-session --recent-activity 30s
yacron list [--project <root>]
yacron show <id>
yacron edit <id> ...
yacron pause|resume|cancel|delete <id>
yacron history <id>
yacron subscribe '*'|<schedule-id>...|<occurrence-id>
```

Calling `schedule` creates an enabled entry. That call is the activation act;
there is no later scan, import, approval, or UI enable step. Read commands do
not activate anything.

The CLI offers the same entry operations as YA's UI, including revising the
instruction, target, time/recurrence, timezone, or pause state. Stable ids and
machine-readable output are part of the first contract so agents do not scrape
display text.

The first scheduling mutation attaches to or starts the provider host under
durable platform service supervision. It fails rather than claiming success if
the entry was not persisted or the host has no credible way to remain running
until the due time. A child left behind by the calling agent shell is not
sufficient.

## Delivery and history

At the due time the provider host first persists a **run occurrence**, then:

- queues an ordinary user turn for a current/existing session; or
- launches a fresh YA session in the selected project and uses the instruction
  as its first user turn.

A busy existing session receives the occurrence at its normal queue boundary;
yacron never steers or interrupts it. A fresh exclusive-project-session
occurrence remains `waiting-project-exclusive` until the configured quiet
condition holds, then atomically reserves the project while launch starts.
Concurrent mode bypasses only this wait; it does not bypass ordinary provider
launch validation.

An occurrence records the entry revision and instruction snapshot, scheduled
and actual times, dispatch/subscription id, resolved YA session id, state,
failure reason, and a provider-host submission receipt. The receipt makes
restart reconciliation idempotent: yacron does not knowingly submit the same
occurrence twice.

The first missed/overlap policy is intentionally small:

- a missed one-shot occurrence runs once when the host returns;
- recurring entries do not backfill every missed tick; at most the latest
  missed occurrence is materialized;
- if the previous occurrence remains queued or running at the next tick, that
  tick is recorded as skipped; and
- failed delivery is recorded and requires an explicit retry/run-now action
  rather than an automatic retry loop.

History is a bounded index into sessions/turns, not a duplicate transcript.

## Dispatch subscriptions

Yacron exposes a retained subscription before a target session necessarily
exists. A caller may subscribe to `*` for every schedule visible under its
cooperative read policy, to one or more schedule ids, or to one concrete
occurrence id. Scheduling returns the schedule id and next planned occurrence
id so a caller can subscribe immediately. A cursor allows reconnect or a later
point-in-time query without keeping the original browser or CLI process open.

The lifecycle includes at least `scheduled`, `due`,
`waiting-project-exclusive`, `starting-or-rejoining`, `session-ready`,
`submitted`, and a terminal outcome. `session-ready` reports:

- whether the provider service started a fresh session, rejoined/resumed an
  existing one, or reused an already-live worker;
- the schedule and occurrence ids, due time, immutable instruction snapshot,
  and any purpose label — what the session was obtained for; and
- the canonical YA session id and final session metadata known after launch or
  rejoin.

This is yacron's notification facility for an interested party, not merely a
live provider event stream. The event is retained in yacron history, so an
observer that disconnects before the start/rejoin result can recover it.
Recurring schedules publish the next planned occurrence id as each cycle
advances.

The subscription is part of yacron's API regardless of process topology. In
the simple co-located version, provider launch and yacron publication happen in
one provider-host process. If yacron later becomes a separate daemon, it relays
the provider service's start/rejoin result and publishes the same yacron event;
clients do not change protocols.

The underlying primitive is a durable launch/join-and-prompt request, not a
yacron-only callback. One accepted request bundles the project wait/reservation,
fresh launch or existing-session rejoin, and initial queued instruction. The
service returns a request id only after taking durable responsibility, and the
same id supports status lookup and the retained stream. This cannot make an
external provider transaction literally atomic, but it gives one owner the
reconciliation job instead of splitting it across callbacks and processes.

That request may be an optional provider-service route or may be owned by a
separate yacron service which calls the provider service. The yacron contract
does not depend on which process serves it.

YA Project Queue can submit the same request as soon as an item is the selected
head of its project queue and subscribe before the queued session has an id.
The request owner performs the exclusive-project wait and atomic reservation,
then publishes the final canonical id/metadata on `session-ready` and the
prompt-acceptance receipt on `submitted`. Project Queue removes or settles its
durable item only from those request states, so a Hono restart can reconnect by
request id instead of losing an in-memory launch callback. Project Queue
retains its backlog ordering and retry/UI policy; the request owner handles the
common quiet wait, reservation, launch/rejoin, initial prompt, and result
stream.

## One host and one timer

There is one generally running provider host per effective YA profile, not one
process per session, project, browser, or schedule. An install supplies normal
OS service supervision for that host on Linux, macOS, and Windows.

The host owns one exact next-deadline timer across all entries. Creating,
editing, pausing, resuming, cancelling, or firing an entry recomputes that one
deadline. There is no fixed polling loop or provider process retained per
entry.

The `yacron` CLI talks to yacron's versioned local control endpoint, exposed by
the provider host in the simple baseline. A full YA server uses an adapter to
expose the same operations and retained subscriptions to its UI; it does not
own a second scheduler or copy state into the browser.

## State and configuration

Entries, revisions, occurrences, and receipts live in one provider-host-owned
store under the user's yacron data area. Clients change that state through the
service API. The storage technology is an implementation detail; the important
first-version rule is one writer and one revision truth.

Returning a schedule id is a durability acknowledgment. Before the service
returns that id, it has committed the entry and every fact needed to reconstruct
it after a crash. On restart, yacron rebuilds its in-memory scheduling set from
that authoritative store. The resulting set is complete and exact for every
acknowledged mutation; restart does not scan known project directories for
stray entry files or reconcile changes made outside the service API.

Project files are a secondary, explicit point-in-time interchange and recovery
surface. A future export may produce native-shell-searchable files suitable for
off-machine backup or an intentional Git commit. An explicit import-as-of-now
operation may then create or revise service-owned entries, with conflicts shown
for resolution. After import, later edits, pulls, checkouts, or deletions of
those files are inert until another explicit import. There is no watched source
mode and no promise that filesystem state continuously mirrors live schedules.

The primary machine-loss path should be a coordinated backup of full YA state,
including the authoritative yacron store. YA does not yet provide a meaningful
live full-state snapshot; [`gaps/live-full-state-backup.md`](../gaps/live-full-state-backup.md)
tracks that separate recovery requirement. Exported project files remain useful
when the central YA data area was not backed up.

Configuration is simpler and intentionally visible:

- global defaults come from a file conceptually at
  `~/.yep/yacron/config.json`; and
- an optional `<project>/.yacron.json` overrides applicable values for entries
  owned by that project.

The exact platform config root may differ, but the precedence does not. The
service does not create project config merely because YA browsed a project.
YA-created project config also requires the explicit global opt-in for
project-local YA writes. Whether the project file is committed is ordinary
project policy.

YA settings map to keys in the global or selected-project yacron config rather
than keeping a parallel settings truth. The simplest write path is for CLI and
YA clients to ask the provider host to update the selected config atomically;
human edits remain readable after reload. UI and CLI show whether an effective
value came from the global or project file.

Agent-oriented cross-project policy has two independent config values:

```json
{
  "agentAccess": {
    "readOtherProjects": true,
    "modifyOtherProjects": true
  }
}
```

Both default to `true`. Read covers list/show/history. Modify covers create,
edit, pause/resume, retry, cancel, and delete. The caller's own project comes
from YA's project marker, an explicit CLI project, or its canonicalized current
project. YA's operator UI may show all projects.

These are cooperative behavior settings, not a security boundary. The first
version trusts same-user local processes and makes no claim that a caller with
filesystem, process, provider, or socket access cannot bypass them.

A future security design would authenticate management calls, give sessions
scoped capabilities (possibly injected by YA when it creates a session), and
make state opaque and mutable only through the provider-host/yacron API. That
is deliberately not part of the simple baseline.

## YA session environment

Enabled YA sessions receive:

- `AGENTCTL_SESSION_ID`, already the canonical YA session id; and
- proposed `AGENT_PROJECT_ROOT`, the canonical absolute project root used to
  launch the session.

The project marker uses the launcher-independent `AGENT_*` namespace rather
than a `YEP_*` configuration name. Yacron derives any internal encoded project
id from the root rather than exposing a second public identity.

When enabled, YA also adds `yacron` to PATH and may inject a short instruction
fragment explaining how to schedule, inspect, and revise entries. Tool
advertisement and the discoverable UI are configurable and default-off under
YA's vanilla-defaults contract. Explicitly invoking an installed binary remains
the activation boundary.

## YA UI

The optional YA surface is a thin service client. It provides:

- entry list/detail, create/edit, pause/resume, retry, cancel, and delete;
- next fire, last run, blocker/failure, history, and config-source views; and
- global/project settings that write the corresponding yacron config.

An optional persistent sidebar alarm can show active-entry count and time until
the next fire. Discrete proximity/color buckets are sufficient; continuous
animation and client polling are unnecessary. The indicator is separately
configurable and default-off.

## Headless install

The minimal install contains the provider host with its yacron scheduler, the
provider adapters, the `yacron` CLI, and service/config/state support. It has no
Hono server, browser client, relay, or web UI.

## Deferred extensions

- **Early preparation:** optionally resume/prepare a provider shortly before
  the due time, without sending the turn early. This is explicit and default-
  off because it may consume resources or begin billing.
- **Project-file import/export:** an `at/`-inspired format could export due-later
  instructions as searchable or intentionally committed project files. They
  are point-in-time recovery artifacts, not a watched scheduling source; only
  an explicit import-as-of-now operation can change live service state.
- **Outside-YA callers:** local endpoint discovery plus explicit project and
  target arguments could let another harness use yacron when its CLI is on
  PATH. Lack of a YA session marker must never trigger origin guessing.
- **Routines:** YA Routines can later use yacron as their sole deadline/run
  engine while retaining their separate reusable-source and user-activation
  semantics. A raw yacron entry need not become a Routine.
- **`at/` migration:** `at/` is prior art or an explicit point-in-time import
  source, not a dependency. It can be retired if yacron proves sufficient.

## Design decisions

- **Provider-host subsystem first (vs. initially adding a second daemon):** one
  lifecycle and one queue owner is the shortest reliable end-to-end design,
  while yacron's subscription contract remains independent of co-location.
- **Service-owned entry state (vs. editable entry files):** one writer avoids
  concurrency and revision ambiguity; explicit config files retain simple
  global/project customization.
- **CLI call activates (vs. source discovery):** the agent's mutating command
  is the intent boundary.
- **Two schedule forms (vs. natural-language parsing):** one-shot RFC 3339 and
  cron-plus-timezone are familiar, explicit, and serializable.
- **One launch/join request (vs. yacron and Project Queue callbacks):** a
  subscribable provider-service request supplies project exclusivity and the
  eventual canonical session identity to either product.
- **Cooperative access settings (vs. authentication):** both cross-project
  defaults are permissive as requested; stronger isolation remains an honest
  later architecture.

## First implementation sequence

1. Add entry/config/occurrence operations and one next-deadline scheduler to
   the provider host, with one-shot and cron schedule tests.
2. Add current/existing-session delivery, retained dispatch subscriptions,
   receipts, restart reconciliation, and CLI CRUD/history.
3. Add fresh-session launch with explicit project exclusivity, share that
   launch/join request with Project Queue, and publish `AGENT_PROJECT_ROOT`
   alongside the existing session marker.
4. Add the default-off PATH/instruction integration and the optional YA
   settings/list/editor adapter.
5. Add the separately enabled sidebar indicator; evaluate deferred extensions
   only after this baseline is dependable.
