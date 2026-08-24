# Boss Mode

> Proposal: a working mode in which the user largely stops driving the
> YA UI directly and delegates session creation, routing, and
> supervision to one designated boss agent session, which orchestrates
> other sessions through agent-session-access primitives and
> ask-session requests and reports back for user decisions.

Topic: boss-mode

Status: proposal, 2026-08-24. Boss mode is a usage pattern plus the
default-off tooling that enables it, not a server state machine: YA
ships the primitives ([`agent-session-access.md`](agent-session-access.md),
[`ask-session.md`](ask-session.md),
[`new-session-agent-tooling.md`](new-session-agent-tooling.md)) and the
boss is an ordinary session using them.

See also:
[`project-queue.md`](project-queue.md);
[`session-wake.md`](session-wake.md);
[`inbox.md`](inbox.md);
[`cross-host-delegation.md`](cross-host-delegation.md) — the cross-host
generalization of the same controller role;
[`vanilla-defaults.md`](vanilla-defaults.md).

## What changes for the user

The user talks mainly to one session — the boss — instead of operating
the dashboard, composer, and session list across many sessions. The
boss:

- creates and routes work (new sessions, Project Queue enqueues,
  ask-session requests to recently-active sessions);
- tracks requests and deliverables in its *boss mailbox* — its own
  request/deliverable store, git-controlled or not, maintained by the
  boss itself and never written by YA
  (`agent-session-access.md` § Rejected);
- supervises progress and reports back, asking the user only at real
  decision points.

The user keeps everything that requires human authority: permission
approvals, gated pushes, and any ceiling the boss cannot raise. The YA
UI remains fully available — boss mode reduces how often the user needs
it, it does not hide it.

## What boss mode is not

- **Not authority elevation.** Boss text delivered to workers is
  agent-authored input, never human approval
  (`claude-cross-session-messaging.md` § The YA Authority Boundary).
- **Not the `~/agents` steward/tending mode.** A steward session
  services an on-deck queue of already-authored work items
  (`agentctl tending`); a boss *originates and orchestrates* — it
  decides what sessions to create, whom to ask, and what to report.
  The two compose: a boss may rely on steward-tended queues.
- **Not a YA server feature.** No boss flag, role, or state machine on
  the server; the enabling tooling ships default-off per
  `vanilla-defaults.md`, and any future boss-specific UI would be a
  separate proposal.

## Naming

*Boss* was chosen over: *supervisor* (collides with the server's
`Supervisor` class and YA's own product description), *steward*
(reserved for the `~/agents` on-deck queue-tending mode above), and
*inbox*-derived names (collide with YA's Inbox attention view). *Boss
mailbox* names its request/deliverable store.
