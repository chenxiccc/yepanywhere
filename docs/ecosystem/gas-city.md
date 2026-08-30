# Gas City, Mission Control, and Yep Anywhere

> Discussion note, 2026-08-30. This records product ideas prompted by Chris
> Sells's Gas City work and his Yep Anywhere feature requests. It is not an
> integration proposal or an approved YA contract.

## Names and starting point

[Gas City](https://github.com/gastownhall/gascity) describes itself as an
orchestration-builder SDK extracted from Gas Town. Gas Town supplied a fairly
opinionated software-organization metaphor; Gas City turns more of that into
configurable primitives: declarative city configuration, rigs, named roles,
runtime providers, Beads-backed work routing, orders, health patrol, and a
controller that reconciles desired and running state.

In a 2026-08-28 email, Chris described **Mission Control** as his fork of YA
integrated with Gas City and asked about finishing it using YA's newer shell and
file-browser work. This note uses *Mission Control* for that proposed Gas City
operator UI, *Gas City* for the current toolkit, and *Gas Town* for the earlier
organizational model.

## The useful tension

Gas Town/City starts from a distributed organization: a rig contains roles and
workers, a Mayor-like principal routes work, and durable work records coordinate
the group. The metaphor can make agent orchestration legible to executives and
non-engineers, and role configuration can preload useful context, permissions,
tools, and operating rules.

YA's emerging **super-session** or **boss mode** starts from the opposite
direction: the user keeps one maximally capable, durable principal session and
lets it delegate only when delegation helps. Topics, tactical documents, and
Project Queue preserve more of the plan as plain project knowledge rather than
as a standing cast of personalities.

These approaches appear compatible. A Mayor could be the designated YA boss
session, while designers, reviewers, or analytics workers could be ordinary
child or sibling sessions created as needed. Roles could then act as launch
profiles and routing labels rather than claims that agents are people. The
principal could supply continuity, while workers could supply parallelism and
context isolation.

The unresolved product question is whether the organizational metaphor produces
better work than a powerful user-directed session. Persistent roles can improve
repeatability and accessibility, but they can also create coordination overhead,
stale local memory, performative agent activity, and token consumption that
looks more impressive than its results. A useful implementation could allow
both workflows instead of requiring every YA project to become a city.

## A possible theme in Chris's YA requests

Chris's early issues can be read as more than unrelated UI requests. Together
they suggest movement from a flat remote chat viewer toward an operator console
for an always-on, multi-agent machine:

- [nested sessions](https://github.com/kzahel/yepanywhere/issues/17) organize a
  project into top-level orchestrators and the workers they spawned;
- [machine load monitoring](https://github.com/kzahel/yepanywhere/issues/16) and
  [child-process PIDs](https://github.com/kzahel/yepanywhere/issues/25) make
  worker resource use and lifecycle attributable;
- [file browsing/editing](https://github.com/kzahel/yepanywhere/issues/9) could
  make the console useful beyond chat, while the terminal request explored a
  more literal remote shell;
- lazy transcript loading, navigation, permission persistence, rename
  consistency, and the
  [live-stream/stale-refetch race](https://github.com/kzahel/yepanywhere/issues/26)
  could all support reliable operation of long-lived sessions.

One possible common theme is **many-session operational legibility**:
understanding which session is doing what, inspecting its artifacts and machine
cost, and safely intervening.

## A possible place for YA in the stack

Gas City can create, classify, and schedule workers. YA might not need to
duplicate that factory. One of its distinctive capabilities is discovering
normal provider rollout files and semantically rendering sessions it did not
create. It could therefore begin as a passive observer of a Gas City, terminal,
desktop, or IDE session and later become its rich control surface.

That transition must be a safe **yield and claim**, never an informal hijack.
YA may read externally written transcripts, but resuming one while another
provider process still owns it creates a second writer and can fork or lose
conversation history. Today's mtime-derived `external`/`none` state is useful
warning evidence, not a sufficient ownership lease.

One possible future composition could be:

```text
Gas City
  city/rig/role metadata, work routing, desired workers
       |
       v
provider sessions and ordinary rollout files
       |
       v
YA session catalog and semantic UI
  observe every session, group Mayor and workers, surface attention
       |
       v
provider service with explicit ownership/handoff
  resume, queue, steer, interrupt, approve, or launch safely
```

Gas City metadata could decorate canonical YA sessions rather than replace
their identities: city, rig, role, parent, work item, and run could be useful
grouping fields, while the provider transcript and YA session id could remain
the durable conversation record. Mission Control could then be a
factory-oriented projection over YA's session catalog instead of a permanently
divergent fork of YA's rendering and control machinery.

## Autonomy without an immortal process

Several YA mechanisms could form a restrained alternative to keeping a Mayor
and all workers running continuously:

| Mechanism | Trigger | Job |
| --- | --- | --- |
| Project Queue | Project becomes safely idle | Start the next durable backlog item. |
| yacron | A wall-clock deadline arrives | Wake an existing principal or start a fresh scheduled session. |
| session wake | An external event completes | Deliver the result immediately to the waiting session. |
| heartbeat turn | An opted-in session stays quiet | Nudge a stalled or prematurely stopped supervisory loop. |

This could allow session identity to remain durable while processes remain
ephemeral. For example, yacron could start a bounded pre-quota-reset campaign;
the Mayor could select work from several project queues and delegate it; worker
completion events could wake the Mayor; and heartbeat could catch lost signals
or unexplained silence.

Such a campaign could benefit from explicit stopping conditions such as an
empty selected backlog, a time or token ceiling, a worker limit, or a decision
requiring the user. Without them, heartbeat plus self-created work could risk
becoming an immortal token burner—the weak version of the factory metaphor.

## Threads worth pulling later

- Explore the smallest Gas City-to-YA metadata adapter that could group a
  Mayor, rigs, workers, and work items without importing the whole metaphor.
- Replace inferred transcript ownership with an explicit lease, delivery
  adapter, or yield/claim protocol before scheduled prompts target
  externally-run sessions.
- Test one outcome-oriented workflow, such as a daily analytics review or a
  bounded quota-reset campaign, before designing a general-purpose software
  organization.
- Consider whether Mission Control could be a view/configuration over YA's APIs
  or might need product behavior that belongs outside YA.
- Evaluate role profiles on repeatability, delivered work, attention saved,
  and cost—not number of agents, generated tasks, or visible activity.

## Related YA topics

- [Boss mode](../../topics/boss-mode.md)
- [Agent session access](../../topics/agent-session-access.md)
- [Session ownership](../../topics/session-ownership.md)
- [Project Queue](../../topics/project-queue.md)
- [Yacron](../../topics/yacron.md)
- [Heartbeat](../../topics/heartbeat.md)
- [Session wake](../../topics/session-wake.md)
- [Federated super-sessions](../../topics/federated-super-sessions.md)
