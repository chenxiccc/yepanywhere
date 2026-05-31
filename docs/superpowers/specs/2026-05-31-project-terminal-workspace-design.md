# Project Terminal Workspace Design

Date: 2026-05-31
Status: Approved in chat, awaiting user review of written spec

## Summary

Add a project-scoped terminal workspace that supports multiple independent terminal tabs per project. Each tab is backed by a server-owned PTY process. Browser refresh, page close, or transient disconnects must not terminate the shell. Reopening any session page for the same project should restore the tab list and allow the client to reattach to the previously selected tab.

This persistence is intentionally in-memory on the server. If the server restarts, terminal tabs are lost and the client should fall back to creating a new tab.

## Goals

- Support multiple independent terminal tabs within a single project
- Keep terminal shells alive when the browser page closes or refreshes
- Restore project terminal state when the user returns to any session page for that project
- Share the same terminal tab set across different session pages in the same project
- Preserve enough recent output to make reconnects feel continuous instead of blank

## Non-Goals

- Persist terminal tabs across server restarts
- Provide a complete terminal transcript or audit log
- Sync terminal state across different servers or profiles
- Introduce external dependencies such as tmux or screen
- Reconstruct exact xterm viewport state such as scroll offset or selection

## Current State

The current implementation opens a single ad hoc terminal modal from a session page. The WebSocket endpoint at `packages/server/src/routes/terminal.ts` spawns a fresh PTY on connect and kills it on disconnect. This makes terminal state entirely client-lifetime-bound:

- no multi-tab model
- no server-held shell lifecycle
- refresh closes the shell
- reopening the modal starts over with a new process

## Proposed Architecture

Introduce a server-side `TerminalWorkspaceRegistry` owned by the server process.

### Registry shape

The registry is keyed by `projectId`.

Each project workspace contains:

- `projectId`
- `tabs: Map<string, TerminalTabRecord>`
- `lastSelectedTabId?: string` (optional convenience only; client remains source of truth for selected tab persistence)

Each terminal tab record contains:

- `tabId`
- `projectId`
- `title`
- `cwd`
- `createdAt`
- `updatedAt`
- `cols`
- `rows`
- `pty`
- `outputBuffer`
- `attachedClients`
- `status: "running" | "exited"`
- `exitCode: number | null`
- `exitedAt: string | null`

### Output buffering

Each tab keeps a ring buffer of recent output chunks in memory.

Purpose:

- replay recent terminal output after reconnect
- avoid blank terminals after refresh
- keep implementation simple without storing full transcripts

Constraints:

- fixed upper bound by bytes or chunks
- oldest content is dropped first
- buffer is not authoritative history

Recommended initial limit:

- 256 KB to 1 MB per tab, exact value to be chosen during implementation based on memory tradeoffs

### Lifecycle model

- Creating a tab spawns a PTY immediately
- Disconnecting a browser client detaches only that client
- PTY lifetime is independent from any one WebSocket connection
- Closing a tab kills its PTY and removes it from the workspace
- Exited tabs may remain in the tab list briefly or until user closes them; exact retention can be implementation-defined, but the default should be to keep them visible until explicitly closed so the user can inspect the last output

## API Design

Add project-scoped terminal tab endpoints under `/api/projects/:projectId/terminal-tabs`.

### `GET /api/projects/:projectId/terminal-tabs`

Returns metadata for all terminal tabs in the project workspace.

Response shape:

```json
{
  "tabs": [
    {
      "id": "tab_123",
      "title": "Terminal 1",
      "cwd": "/repo/path",
      "createdAt": "2026-05-31T10:00:00.000Z",
      "updatedAt": "2026-05-31T10:05:00.000Z",
      "status": "running",
      "exitCode": null
    }
  ]
}
```

### `POST /api/projects/:projectId/terminal-tabs`

Creates a new tab and PTY.

Request shape:

```json
{
  "title": "optional",
  "cwd": "optional"
}
```

Behavior:

- default `cwd` is the project root
- default title is generated server-side

### `PATCH /api/projects/:projectId/terminal-tabs/:tabId`

Updates mutable tab metadata.

Initial scope:

- rename tab title only

Future-safe to add:

- reset cwd policy if the product later exposes "new tab from here"

### `DELETE /api/projects/:projectId/terminal-tabs/:tabId`

Kills the PTY, removes the tab, and broadcasts removal to any connected clients.

## WebSocket Design

Replace the current project terminal WebSocket with a tab-targeted endpoint:

- `WS /api/projects/:projectId/terminal-tabs/:tabId/ws`

### Client to server messages

```ts
type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
```

### Server to client messages

```ts
type TerminalServerMessage =
  | { type: "snapshot"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };
```

### Attach flow

When a client connects:

1. validate `projectId` and `tabId`
2. attach the client to the existing tab
3. send a single `snapshot` message containing the current buffer contents
4. continue streaming live `output`

This avoids the need for the client to infer whether incoming data is replay or live.

### Resize semantics

The active attached client controls PTY size by sending `resize`.

For MVP:

- last resize wins
- do not attempt multi-client size arbitration

This is acceptable because the product target is personal supervision rather than concurrent collaborative terminal use.

## Client Design

Replace the current single-terminal modal view with a terminal workspace modal.

### New UI model

The modal contains:

- a tab strip at the top
- new tab action
- close tab action
- rename tab action
- one xterm instance bound to the currently selected tab

The terminal workspace remains project-scoped even though it is launched from a session page.

### Client persistence

Persist minimal project-scoped UI state in `localStorage`.

Store:

- selected tab id for each `projectId`

Do not store:

- terminal output
- tab process status as source of truth
- modal open state by default

The server remains authoritative for tab existence and runtime state.

### Page load / restore flow

On terminal modal open:

1. fetch tab list with `GET /terminal-tabs`
2. read the last selected `tabId` for the project from `localStorage`
3. if the tab still exists, select it
4. else select the most recently updated tab
5. if no tabs exist, auto-create one
6. connect the WebSocket for the selected tab
7. render `snapshot`, then continue with live `output`

### Tab switching flow

When the user selects another tab:

1. persist selected `tabId` to `localStorage`
2. disconnect current tab WebSocket
3. connect to the selected tab WebSocket
4. render the new tab snapshot and continue streaming

The client must not request the server to kill the previous shell during tab switch.

## Server Events and Broadcasting

To keep multiple session pages consistent for the same project, terminal tab metadata changes should propagate to all clients with the terminal workspace open.

Two implementation options are acceptable:

1. a dedicated workspace metadata WebSocket
2. lightweight polling when the modal is open

Recommendation:

- start with lightweight polling if it significantly reduces implementation complexity
- use a dedicated metadata stream only if polling creates visible lag or code duplication

For the PTY data stream itself, a per-tab WebSocket is still required.

## Cleanup Policy

Because tabs are server-owned and survive disconnects, explicit cleanup rules are required.

### Required cleanup

- closing a tab kills the PTY immediately
- server shutdown kills all PTYs as part of process teardown

### Idle cleanup

For MVP, do not auto-kill detached running tabs.

Rationale:

- aligns with the user requirement that page close should not kill the session
- keeps behavior predictable
- avoids surprising data loss while a long-running command is active

Future enhancement:

- optional idle timeout or max detached tab count per project

## Error Handling

### Missing project

- `GET/POST/WS` return project-not-found errors consistent with existing route behavior

### Missing tab

- if selected `tabId` no longer exists, client falls back to another existing tab or auto-creates one

### Exited shell

- the tab remains visible with exit state
- reconnect shows buffered output and exit status
- user may close it or create a new tab

### Invalid WebSocket messages

- send structured error and keep connection behavior consistent with current terminal implementation

## Testing Strategy

### Server tests

Add route and registry tests covering:

- create/list/rename/delete tab
- PTY survives WebSocket disconnect
- reconnect receives buffered snapshot
- delete kills the PTY
- project isolation between two workspaces
- invalid project or tab handling

### Client tests

Add component tests covering:

- terminal workspace modal renders tabs
- auto-create first tab when none exist
- selected tab persistence via `localStorage`
- switching tabs reconnects to the right endpoint
- exited tabs render status instead of disappearing

### Manual verification

- open terminal, run a long-lived command, refresh page, verify shell is still alive
- open two tabs in the same project, run different commands, switch between them
- open another session page from the same project and confirm it sees the same tab set
- close one tab and verify other tabs remain unaffected

## Implementation Notes

### Suggested server structure

Potential new files:

- `packages/server/src/terminal/TerminalWorkspaceRegistry.ts`
- `packages/server/src/terminal/TerminalTab.ts`

`packages/server/src/routes/terminal.ts` should become a thin route layer over the registry.

### Suggested client structure

Potential refactor targets:

- replace `SessionTerminalModal.tsx` with a project terminal workspace modal
- add a small `useProjectTerminalWorkspace` hook for list/create/select/delete behavior

### Migration path

1. introduce registry and REST endpoints
2. move current WebSocket spawn logic behind registry-managed tabs
3. update modal UI from single terminal to tabbed workspace
4. add selected-tab persistence
5. add tests

## Open Decisions

These are intentionally left to implementation unless product feedback changes them:

- exact output buffer size
- default new tab title format
- whether exited tabs remain indefinitely or until closed
- whether workspace metadata sync uses polling or push

None of these change the core architecture.

## Recommendation

Implement the server-owned project terminal workspace with one PTY per tab. This is the smallest design that fully satisfies:

- page refresh recovery
- page close recovery
- independent multi-tab terminals
- project-scoped sharing across session pages

It also stays aligned with the existing architecture and avoids introducing tmux or any external session manager.
