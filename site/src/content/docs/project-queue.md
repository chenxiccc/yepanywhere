---
title: Project Queue
description: Schedule durable follow-up work that starts after every session in a project becomes quiet.
---

Project Queue is an experimental, server-owned backlog for work that should
start only after an entire project becomes quiet. It is different from the
normal per-session queue.

## When to use it

Use a normal queue when the current session should receive the next message.
Use Project Queue when a follow-up must wait for active turns, session queues,
other sessions, and known external work in the same project to drain.

Examples:

- Run the test-fix pass after every agent in a repository finishes.
- Start a fresh review session only when current implementation work is quiet.
- Preserve follow-up work across a browser refresh or server restart.

## Enable the controls

Project Queue entry controls are opt-in and capability-gated. Open toolbar or
composer settings and enable the Project Queue actions you want. Hosted clients
hide them when the connected server is too old to provide the complete
contract.

## Delivery order

Project Queue waits behind:

1. Active provider turns.
2. Direct per-session queued messages.
3. Deferred or patient per-session messages.
4. The server-computed project quiet window.
5. Earlier Project Queue work for that project.

One item promotes at each verified project-idle boundary. The scheduler does
not dump the entire backlog into an agent at once.

## Manage the backlog

The Projects page shows queued items, why an item is blocked, and whether
dispatch is paused or waiting for quiet. Depending on state, you can copy,
edit, cancel, retry, reorder, start, or explicitly force an item.

After a server restart, persisted Project Queue work starts paused so you can
inspect interrupted work before resuming dispatch. Editing or dispatching a
valid item also resumes the global dispatcher.

## Safety boundaries

- Queued text is persisted and delivered verbatim.
- The client does not hold an invisible local-only schedule.
- Normal project-idle detection is best-effort for externally owned provider
  work.
- Force start overrides visible idle blockers, not per-project in-flight
  protection.
