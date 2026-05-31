# Project Terminal Workspace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped terminal tabs that survive browser refresh/close, support multiple independent tabs, and restore by project.

**Architecture:** Replace the current one-off terminal modal with a project terminal workspace backed by a server-side registry. Each tab owns a long-lived PTY and a bounded output buffer; the client reconnects by `projectId + tabId`, restores the last selected tab from `localStorage`, and renders one xterm instance for the active tab.

**Tech Stack:** TypeScript, Hono, node-pty, React 19, xterm.js, Vitest, Testing Library

---

## Chunk 1: Server terminal workspace registry and API

**Files:**
- Create: `packages/server/src/terminal/TerminalWorkspaceRegistry.ts`
- Create: `packages/server/src/terminal/TerminalWorkspaceTypes.ts`
- Modify: `packages/server/src/routes/terminal.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/routes/terminal-workspace.test.ts`

- [ ] **Step 1: Write the failing registry/API tests**

Create tests that describe the new project-scoped behavior:

```ts
it("creates, lists, renames, and deletes project terminal tabs", async () => {});
it("keeps PTY state alive after websocket disconnect", async () => {});
it("replays buffered output on reconnect", async () => {});
it("isolates tabs by projectId", async () => {});
it("returns 404 for missing project or tab", async () => {});
```

- [ ] **Step 2: Run the new server test file and confirm it fails**

Run: `pnpm --filter server test -- test/routes/terminal-workspace.test.ts -v`

Expected: fail because the registry and endpoints do not exist yet.

- [ ] **Step 3: Implement the registry and endpoints**

Implement:

```ts
export interface TerminalTabRecord { /* metadata, pty, buffer, status */ }
export class TerminalWorkspaceRegistry { /* getWorkspace, createTab, attach, detach, rename, delete */ }
```

Update `packages/server/src/routes/terminal.ts` to expose:

```ts
GET    /api/projects/:projectId/terminal-tabs
POST   /api/projects/:projectId/terminal-tabs
PATCH  /api/projects/:projectId/terminal-tabs/:tabId
DELETE /api/projects/:projectId/terminal-tabs/:tabId
WS     /api/projects/:projectId/terminal-tabs/:tabId/ws
```

Wire the registry into `packages/server/src/index.ts`.

- [ ] **Step 4: Run the server tests until they pass**

Run: `pnpm --filter server test -- test/routes/terminal-workspace.test.ts -v`

Expected: PASS.

- [ ] **Step 5: Commit the server chunk**

```bash
git add packages/server/src/terminal packages/server/src/routes/terminal.ts packages/server/src/index.ts packages/server/test/routes/terminal-workspace.test.ts
git commit -m "Add project terminal registry"
```

## Chunk 2: Client terminal workspace modal and restore flow

**Files:**
- Create: `packages/client/src/components/ProjectTerminalWorkspaceModal.tsx`
- Create: `packages/client/src/hooks/useProjectTerminalWorkspace.ts`
- Modify: `packages/client/src/components/SessionTerminalModal.tsx`
- Modify: `packages/client/src/pages/SessionPage.tsx`
- Modify: `packages/client/src/api/client.ts`
- Modify: `packages/client/src/i18n/en.json`
- Modify: `packages/client/src/i18n/zh-CN.json`
- Modify: `packages/client/src/i18n/de.json`
- Modify: `packages/client/src/i18n/es.json`
- Modify: `packages/client/src/i18n/fr.json`
- Modify: `packages/client/src/i18n/ja.json`
- Test: `packages/client/src/components/__tests__/ProjectTerminalWorkspaceModal.test.tsx`

- [ ] **Step 1: Write the failing client tests**

Create tests for:

```ts
it("restores the last selected tab per project from localStorage", async () => {});
it("auto-creates a tab when a project has none", async () => {});
it("switches tabs without killing the previous shell", async () => {});
it("renders exited tabs with exit status", async () => {});
```

- [ ] **Step 2: Run the new client test file and confirm it fails**

Run: `pnpm --filter client test -- components/__tests__/ProjectTerminalWorkspaceModal.test.tsx -v`

Expected: fail because the workspace modal/hook do not exist yet.

- [ ] **Step 3: Implement the workspace modal and hook**

Build the xterm container once, add a tab strip, and reconnect the active tab WebSocket on selection changes. Persist only selected `tabId` per `projectId` in `localStorage`.

Update `SessionPage.tsx` so the session menu opens the new workspace modal instead of the old single-terminal modal.

Add client API helpers for list/create/rename/delete tab operations.

- [ ] **Step 4: Update i18n strings**

Add or adjust labels for:

```json
sessionMenuOpenTerminal
terminalNewTab
terminalRenameTab
terminalCloseTab
terminalTabExited
```

- [ ] **Step 5: Run client tests until they pass**

Run: `pnpm --filter client test -- components/__tests__/ProjectTerminalWorkspaceModal.test.tsx -v`

Expected: PASS.

- [ ] **Step 6: Commit the client chunk**

```bash
git add packages/client/src/components/ProjectTerminalWorkspaceModal.tsx packages/client/src/hooks/useProjectTerminalWorkspace.ts packages/client/src/components/SessionTerminalModal.tsx packages/client/src/pages/SessionPage.tsx packages/client/src/api/client.ts packages/client/src/i18n/*.json packages/client/src/components/__tests__/ProjectTerminalWorkspaceModal.test.tsx
git commit -m "Add project terminal workspace UI"
```

## Chunk 3: Integration cleanup and verification

**Files:**
- Modify: `packages/client/src/components/SessionMenu.tsx`
- Modify: `packages/client/src/pages/SessionPage.tsx`
- Modify: `packages/server/src/routes/terminal.ts`
- Test: `packages/server/test/routes/terminal-workspace.test.ts`
- Test: `packages/client/src/components/__tests__/ProjectTerminalWorkspaceModal.test.tsx`

- [ ] **Step 1: Remove old single-terminal assumptions**

Delete any leftover references to the old `/terminal/ws` modal flow once the workspace path is live.

- [ ] **Step 2: Add regression tests for same-project sharing**

Verify two different session pages for the same project see the same terminal tab list and selected tab restoration remains project-scoped.

- [ ] **Step 3: Run the relevant test suites**

Run:

```bash
pnpm --filter server test -- test/routes/terminal-workspace.test.ts -v
pnpm --filter client test -- components/__tests__/ProjectTerminalWorkspaceModal.test.tsx -v
pnpm lint
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 4: Commit the integration cleanup**

```bash
git add packages/client/src/components/SessionMenu.tsx packages/client/src/pages/SessionPage.tsx packages/server/src/routes/terminal.ts
git commit -m "Finish project terminal workspace integration"
```

## Verification

- Open a terminal tab, run a long-lived command, refresh the page, and confirm the shell is still alive.
- Open two tabs in the same project and verify they stay independent.
- Open another session page in the same project and confirm it sees the same tab set.
- Close one tab and confirm other tabs remain running.
