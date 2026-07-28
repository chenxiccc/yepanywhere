# Agents Process Observability

> Proposal: make Agents YA's host process observability view, inventorying
> YA-supervised and externally launched local provider processes with bounded
> OS metrics while keeping process health distinct from Inbox attention.

Topic: agents-process-observability

See also:

- [`agents-activity-preview.md`](agents-activity-preview.md) — the separate
  optional answer to “what is each supervised agent doing?”
- [`inbox.md`](inbox.md) — the session-attention view; process existence and
  resource use do not imply that a session needs attention.
- [`session-ownership.md`](session-ownership.md) — today's `external` session
  ownership is a recent-transcript-write heuristic, not OS process evidence.
- [`provider-state-machine.md`](provider-state-machine.md) — provider state and
  safe controls for processes YA supervises.
- [`agent-working-directory-tracking.md`](agent-working-directory-tracking.md)
  — an observed process working directory must not silently reclassify a
  session's effective project.
- [`architecture-mandates.md`](architecture-mandates.md) — sampling must stop
  when no visible client owns it.
- [`server-capabilities.md`](server-capabilities.md) and
  [`remote-hosted-compatibility.md`](remote-hosted-compatibility.md) — a new
  host-process route requires an exact capability gate.
- [`security.md`](security.md) — authenticated host diagnostics must stay out
  of public-share surfaces.

## Verified Current Shape

Agents currently shows the YA Supervisor inventory, not the host's agent
process inventory:

- `AgentsPage` reads `useProcesses`, which fetches
  `GET /api/processes?includeTerminated=true`.
- `Process.getInfo` supplies YA process state, Supervisor start time, queue
  depth, and an optional provider child PID. The route enriches those rows with
  session title, provider, model, context usage, and provider children.
- The page groups YA-owned rows into Active and Idle, plus a bounded list of
  recently Stopped YA rows. It already renders PID and Supervisor uptime when
  available, but it has no CPU or memory sampler.
- `ExternalSessionTracker` marks a session `owner: "external"` after a recent
  provider transcript write and decays that guess after roughly 30 seconds. It
  does not discover a foreign PID, prove that a process remains alive, or feed
  an external row into Agents.

Kyle's “active agent processes” description is therefore the right product
direction but broader than the implementation. Today the page is more exactly
“provider processes YA owns, including retained idle and recently stopped
ones.”

## Surface Boundaries

| Surface | Primary question | Source of truth |
| --- | --- | --- |
| Inbox | Which sessions need attention, are active, recent, or unread? | Session, pending-input, queue, and notification state. |
| Agents | Which agent processes exist on this YA host, who supervises them, and what resources are they using? | YA Supervisor state plus an opt-in host process snapshot. |
| Agents activity preview | What is each YA-supervised agent doing now? | Bounded normalized provider activity, when explicitly enabled. |
| Session detail | What happened in this conversation, and what can I do next? | Provider transcript and live session control state. |

External process rows must never enter Inbox merely because their PID exists or
their CPU is nonzero. Conversely, an external transcript write may make a
session relevant to Inbox without YA having enough evidence to identify a
corresponding OS process.

## Recommended Product Shape

Add one server-owned **Host process observability** option. The initial feature
is default-off under [`vanilla-defaults.md`](vanilla-defaults.md), both because
it adds YA-specific UI and because external discovery inspects the same-user
host process table. With it off:

- Agents remains observably unchanged;
- no new process route is requested by the client; and
- YA does not enumerate foreign processes or retain CPU samples.

With it on:

1. Existing YA-owned Active and Idle cards gain host metrics when their local
   provider PID can be sampled.
2. Agents adds an **External** section between Active and Idle for live,
   high-confidence provider processes not owned by this Supervisor.
3. Recently Stopped remains YA history. YA must not manufacture stopped
   history for a foreign process that simply disappeared between samples.

An External row is explicitly read-only. It carries an **Outside YA** badge and
has no Kill, Interrupt, queue, model, permission, or approval action. Adding
attach/adopt/stop behavior would require a separate provider-specific safety
contract; process discovery does not authorize control.

### Compact metrics and details

The minimum useful glance is:

```text
812 MiB RSS · 3% CPU · 18m
```

The compact cluster may stay inline where it fits. It must also open an
accessible tooltip/popover on pointer rest or keyboard focus and on tap for
touch users. A native `title` alone is insufficient because Agents is
mobile-first.

The detail surface should show:

- managed by YA or Outside YA;
- provider and PID;
- process start time and age;
- recent root-process CPU, including its sample window;
- resident memory for the agent root and its process tree;
- descendant process count;
- sample age; and
- exact session/project association when one is known.

Use one shared host-process facts component for Agents cards and the existing
Process Info process section so the same metric cannot acquire two labels or
formatters.

## Metric Semantics

Metrics are nullable observations, not provider state:

| Metric | Contract |
| --- | --- |
| Process age | `sampledAt - OS process startedAt`. It is neither session age nor “time since YA detected it.” Existing Supervisor uptime may remain separately available for diagnostics. |
| Recent CPU | Delta of the identified root process's cumulative user + system CPU time over the actual sample interval. `100%` means one logical CPU fully occupied; a multithreaded process may exceed `100%`. The first observation has no CPU rate. |
| Root RSS | Resident set size of the identified agent root process. It is not V8 heap, virtual memory, context usage, or model memory. |
| Tree RSS | Approximate sum of resident set size for the root and its sampled descendants, available in process details. Shared pages may be counted once per process. |
| Descendants | Count observed in the same process-tree snapshot used for Tree RSS. |
| Sample age | Time since `sampledAt`; stale CPU rates are omitted rather than presented as current. |

Zero CPU does not mean idle, waiting for input, wedged, or safe to stop. Nonzero
CPU does not prove a model turn is progressing. Only YA-owned provider state
may use the existing `in-turn`, `waiting-input`, and `idle` labels.

Do not add virtual memory, host load average, I/O rates, thread count, file
descriptor count, or graphs to the first slice. They can follow when a concrete
diagnostic question needs them; the three requested signals above already
cover footprint, recent work, and lifetime.

## Host Discovery And Identity

Discovery should be a provider registry concern, not an argv regexp embedded in
the route or `AgentsPage`. Each supported local provider may contribute a
high-confidence executable/process-tree matcher. The scanner:

1. takes one same-user host process snapshot;
2. identifies canonical provider roots;
3. joins known YA child PIDs to Supervisor process IDs;
4. removes duplicate helper/wrapper descendants; and
5. reports unmatched canonical roots as external.

A provider-looking descendant of another recognized agent root is not a second
top-level Agents row in the first version. Its resources remain in the
ancestor's Tree RSS. This avoids duplicate app-server/helper rows and
double-counted process trees while still finding independently launched CLI or
desktop agents.

Use PID plus OS start time as observation identity. PID alone is unsafe because
the OS may reuse it after a process exits.

False negatives are preferable to false positives. A basename collision or
ambiguous wrapper must not expose an unrelated host process as an agent.
Provider adapters should be tested against the actual launch shapes YA supports
on each platform.

### Session correlation

Process discovery and session correlation are separate:

- A YA-owned PID has an exact Supervisor process/session join.
- A foreign process may link to a session only when a provider-native session
  ID, verified pid/lock record, or other exact provider contract establishes
  the association.
- Transcript mtime proximity, matching project directory, low CPU, and “only
  one candidate exists” are not enough.
- An uncorrelated external row remains useful as
  `Codex · Outside YA · PID 1234`; it must not invent a session title or make
  the whole card a broken session link.

The current `ExternalSessionTracker` may decorate an exact join, but its
30-second write window cannot create one. An observed cwd may be mapped to an
already-known project for display, but it must not update session metadata or
reclassify the session.

## Proposed Data And Route Boundary

The shape below is illustrative; the distinctions are contractual:

```ts
interface HostAgentProcessObservation {
  observationId: string; // stable for PID + OS start time
  pid: number;
  parentPid?: number;
  provider: ProviderName;
  supervision: "ya" | "external";
  supervisorProcessId?: string; // exact YA join only
  session?: {
    sessionId: string;
    projectId: UrlProjectId;
  }; // exact correlation only
  startedAt: string;
  sampledAt: string;
  cpu?: {
    rootPercent: number;
    windowMs: number;
  };
  memory?: {
    rootRssBytes: number;
    treeRssBytes: number;
    descendantCount: number;
  };
}
```

Expose this through a new authenticated
`GET /api/host-agent-processes` route, guarded by a permanent
`host-agent-process-observability` server capability. Keep
`GET /api/processes` authoritative and unchanged for Supervisor state and
control. The client joins an owned observation through
`supervisorProcessId`; it does not reinterpret external observations as
`ProcessInfo`.

This separation avoids three compatibility failures:

- an older client never receives an external row with controls intended for a
  YA-owned `ProcessInfo`;
- a new client makes no unsupported request to an older server; and
- metric refresh does not repeatedly invoke the existing process route's
  session-summary enrichment.

Before implementation, perform the required optional-feature release audit and
present the exact compatibility review. The intended fallback is: without the
new capability, hide host metrics and External entirely, retain current Agents,
and make no host-process request. Existing capability meanings and older
capable behavior remain unchanged.

## Sampling And Resource Lifetime

Recent CPU needs two samples, but it does not need a permanent server timer.
Recommended lifecycle:

- while Agents is visible, the client requests one lightweight host snapshot
  about every five seconds;
- pause when the page is unmounted or the document is hidden;
- each request reads the process table once, never once per row;
- the server coalesces simultaneous requests into one short-lived snapshot;
- a bounded previous-sample map keyed by PID + start time supplies CPU deltas
  and prunes vanished identities; and
- disabling the option drops the sample cache.

The server performs no repeating work when no client asks. A remote or hosted
client observes the host running its connected YA server; it does not inspect
the browser device. SSH executor processes, containers outside the YA host
namespace, and other YA servers are out of scope for the first version.

Platform adapters may use Linux `/proc` and one whole-table macOS process
snapshot. Unsupported platforms return an explicit unsupported state rather
than spawning a fragile per-PID command loop. Windows support can follow behind
the same route contract.

## Security And Privacy

Host process enumeration is an authenticated operator feature:

- never expose the route through public session shares;
- never send process environment variables to the client;
- inspect argv only long enough to classify a provider, then discard it;
- never log raw argv because prompts, paths, and credentials may appear there;
- return a working directory only when it maps to a project YA already knows;
  and
- omit a row or metric when OS permissions prevent a reliable observation.

The server setting should say that enabling external discovery inspects
same-user process metadata. Relay encryption protects the transport but does
not weaken the server-side minimization rule.

## Observable Contract If Implemented

- With Host process observability off or unsupported, Agents and its resource
  use are unchanged.
- YA-owned rows retain their existing state, controls, ordering, and stopped
  history; host metrics only decorate them.
- Every external row corresponds to a currently observed, high-confidence
  provider process not owned by this Supervisor.
- External rows are read-only and never appear in Inbox merely due to process
  existence.
- CPU is labeled as a recent sampled root-process rate, memory distinguishes
  root RSS from approximate process-tree RSS, and age is OS process age.
- Missing or stale metrics render as unavailable, never zero.
- No row infers provider activity, attention, ownership, or safety from CPU or
  memory.
- Session links and titles appear only after exact process/session
  correlation.
- Leaving or hiding Agents stops client sampling; no stale page leaves a
  server poller, timer, watcher, or retry loop behind.
- Raw argv, environment data, and unrelated host processes never cross the API
  boundary.

## Delivery Slices

1. **Owned metrics.** Add the host snapshot adapter, capability-gated route,
   CPU delta cache, and accessible metric details for known local YA PIDs.
   This validates metric semantics and process-tree accounting without
   process classification.
2. **External inventory.** Add opt-in provider root matchers and the read-only
   External section, initially without session links.
3. **Exact provider correlation.** Add provider-specific joins only where
   verified native evidence exists. Leave the rest unlinked.
4. **Evaluate the default.** Measure usefulness, sampler overhead, false
   positives, and mobile density before considering promotion from default-off.

The activity-preview proposal can proceed independently. It consumes provider
events for YA-owned sessions; host observability consumes OS snapshots and must
not become a second transcript/activity pipeline.

## Non-Goals

- A general-purpose host task manager.
- Killing, interrupting, adopting, or reconfiguring external processes.
- Guessing provider state or user attention from resource use.
- Listing every provider transcript or recently modified external session.
- Showing every tool subprocess as its own agent row.
- Persisting metric history or drawing long-term resource graphs.
- Inspecting remote SSH hosts or arbitrary containers.
- Exposing command lines, environments, or unknown working directories.

## Open Questions

- Which external launch shapes can each provider identify with sufficiently
  low false-positive risk on Linux and macOS?
- Should the compact card always show all three metrics, or show age inline
  and keep CPU/memory in the detail popover on narrow layouts?
- Which providers expose exact external PID/session correlation without
  relying on transcript timing or open-file heuristics?
