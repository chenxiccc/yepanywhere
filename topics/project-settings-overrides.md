# Project Settings Overrides

> Project settings hold narrowly justified project conventions that seed new
> sessions ahead of global defaults without mutating existing sessions.

Topic: project-settings-overrides

See also: [settings-ui-placement](settings-ui-placement.md) § Server-definitive
settings and constants — the global tier this resolution order sits above, and
the rule that a value an API suffers variation in should be server-definitive
rather than a constant each client carries. A value that is server-definitive
because it partitions a server cache is a poor candidate for a project
override, since a per-project value re-partitions that cache along a different
axis.

Status: **first narrow surface implemented.** Heartbeat interval and message
defaults are project-scoped session seeds. This realizes the earlier banked
idea without turning Project Settings into a general override framework.

## Shape

- Resolution order: project override → global setting → built-in default.
- Scope: an override seeds missing metadata when a new session is established
  in that project. Existing sessions retain their session-local values, and
  project defaults never enable heartbeat turns by themselves.
- A stored `null` means inherit the global value. Clearing an override does not
  erase the project's recently used heartbeat messages.
- Project-scoped state lives in YA's app-data project metadata, never inside
  the selected project directory or its Git metadata.

## Heartbeat defaults surface

- `GET` and `PATCH /api/projects/:projectId/session-defaults` expose the
  project heartbeat interval/message overrides plus up to eight recently used
  project heartbeat messages, most recent first.
- The server accepts intervals from 1 through 1,440 minutes and heartbeat
  messages up to 2,000 characters. Empty explicit messages are invalid.
- Project Settings is reachable from the project card's ellipsis or context
  menu and from the session header menu. A client that does not observe the
  `project-session-defaults` capability hides those entries and makes no
  unsupported request.
- The interval and message can inherit independently. The UI shows the current
  global interval and uses the current global message as the inherited editor
  hint.

## Precedent and reopen conditions

[[attachment-storage]] § "Future: per-project override" records the same
resolution pattern for one setting. Continue adding project scope one concrete
setting at a time. A general project-overrides framework is justified only once
several settings need the same resolution and visualization machinery.
Candidate later adopters remain attachment storage location and
[[interactives]] exposure/tunnel policy.

## See also

- [[server-plugin-arch]] — the heavier project-specific mechanism banked in
  the same chat.
- [[settings-ui-placement]] — where an override surface would have to live
  if built.
