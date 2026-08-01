# Provider fork-session support

> `forkSession` is YA's real transcript-fork primitive: make a new resumable
> session from a retained prefix of an existing one. Claude, Codex, and Pi
> implement it. This doc records the provider-specific mechanics and remaining
> constraints. It is the writable-primitive companion to
> [provider-session-tree](provider-session-tree.md), whose `canForkAtNode`
> resolves to "this provider implements `forkSession` anchored at a node."

Topic: provider-fork-support

Related topics:
[session-context-actions](session-context-actions.md) (fork-capability ground
truth and the per-turn fork decision),
[fork-from-turn](fork-from-turn.md) (the UI/jobs built on top of the
primitive),
[provider-session-tree](provider-session-tree.md) (the read-side tree model;
fork is its write side),
[session-ownership](session-ownership.md) (multi-writer hazard that bears on
file-copy forks),
[pi-provider](pi-provider.md),
[codex-api-provider](codex-api-provider.md),
[recaps](recaps.md) (fork-backed summary strategy that fails closed without a
fork primitive).

## The capability contract

There is no static `supportsForkSession` flag a provider sets. The capability
is *derived* purely from method presence:

- `routes/providers.ts:101` — `supportsForkSession: typeof
  provider.forkSession === "function"`.
- `Supervisor.supportsForkSession` (`Supervisor.ts:1919`) — same
  `typeof provider?.forkSession === "function"` test.

So enabling a provider means implementing the method; the flag flips on by
itself, and `routes/sessions.ts` fork endpoints (3622, 3887, 4030, 4185)
unguard automatically. The interface (`providers/types.ts:294`):

```ts
forkSession?: (options: {
  sessionId: string;       // source provider session id
  cwd: string;             // project working dir the session belongs to
  upToMessageId?: string;  // inclusive prefix slice; omit for full copy
  title?: string;          // title for the new session
}) => Promise<{ sessionId: string }>;
```

Contract obligations, not just the shape:

- **New, separately resumable session id.** The result is a top-level session
  YA can resume on its own — not a branch leaf inside the source file.
- **Provider-native retained prefix.** The kept transcript content must match
  the source so provider prompt-cache warmth survives the fork; provider-owned
  ids, parent links, and fork metadata may change only as required to make the
  new session self-consistent (the whole reason recaps and fork-after-summary
  use a real fork instead of a serialized replay — [recaps](recaps.md),
  [fork-from-turn](fork-from-turn.md)).
- **Inclusive slice.** `upToMessageId` keeps up to *and including* that id.
- **Never emulated when absent.** Absence means the capability does not exist;
  YA must not ship a fork-labeled button backed by replay/forgery on a provider
  that cannot truly fork (`session-context-actions.md` § Fork; `types.ts:291`).

## Reference implementation: Claude

`ClaudeProvider.forkSession` (`claude.ts:1325`) delegates to the agent SDK's
`forkSession(sessionId, { dir, upToMessageId, title })`. The SDK copies the
jsonl into a new session file, remaps UUIDs, preserves the parent chain, and
slices inclusively at `upToMessageId`. No provider runtime is spawned — it is a
pure durable-file operation. Forks drop undo/file-history snapshots. This is the
model the other providers should match: produce a self-consistent durable file
under a fresh id without needing a live agent process.

## Codex

**LANDED 2026-06-23.** `CodexProvider.forkSession` uses the native app-server
`thread/fork` RPC and returns the forked Codex thread id as YA's provider
session id. YA vendors the generated `ThreadFork*`, `ThreadRollback*`, and
`ThreadReadResponse` protocol types through
`scripts/update-codex-protocol.mjs`.

Codex models forks natively in its app-server protocol. The vendored v2
`Thread` type (`codex-protocol/generated/v2/Thread.ts`) carries:

- `sessionId` — "Session id shared by threads that belong to the same session
  tree" (Codex already models a session as a *tree of threads*);
- `forkedFromId` — "Source thread id when this thread was created by forking
  another thread";
- a docstring naming `thread/fork` and `thread/rollback` as real methods (turns
  are populated on `thread/resume`, `thread/rollback`, `thread/fork`,
  `thread/read`).

Implementation:

1. For a full fork, YA calls `thread/fork` with the source `threadId`, `cwd`,
   and the normal default Codex permission policy. The native response's
   `thread.id` becomes `{ sessionId }`.
2. For a sliced fork, YA first calls `thread/read` with `includeTurns: true`,
   maps `upToMessageId` back to a Codex turn/item id, calls `thread/fork`, then
   calls `thread/rollback` on the forked thread to drop trailing turns.
3. Codex can roll back whole turns, not arbitrary items inside a turn. YA
   therefore fails clearly if `upToMessageId` resolves to an item before the
   end of its turn; silently retaining later items would violate the inclusive
   prefix contract.

**Known addressability failure (2026-08-01):** the capability is advertised,
but the shipped per-turn client can pass a synthesized normalized id such as
`codex-112-<timestamp>` into this lookup. That id is a YA display identity, not
an app-server turn/item id, so `findCodexForkAnchor` reports it missing. The
client Fork after resolver can separately stop at a user-role `tool_result` and
choose an inside-turn tool call. Provider method presence therefore does not
currently make Codex sliced fork usable end to end. The typed identity repair,
server-owned completed-turn resolver, and direct full Clone surface are planned
in
[`docs/tactical/075-session-fork-clone-unification.md`](../docs/tactical/075-session-fork-clone-unification.md).

Why not copy the rollout file like Claude does: `session-context-actions.md`
already flags Codex multi-writer behavior as open and calls a rollout-file copy
"plausible but unverified." A hand-copied file also misses the `sessionId` /
`forkedFromId` tree fields and risks schema drift on a format Codex owns.
The native method is the supported path.

**Constraint vs. Claude:** `thread/fork` needs a live app-server client, unlike
Claude's process-free file copy. The fork endpoint must therefore tolerate
spawning/holding an app-server connection — acceptable, since YA already manages
one per Codex session, but it is a behavioral difference from the
"durable-file-only" reference.

## Pi

**LANDED 2026-06-23.** `PiProvider.forkSession` creates a YA-authored Pi JSONL
session file and returns its new filename id. Pi v3 JSONL stores top-level
`id` + `parentId` on every entry; YA already reads this through
`PiSessionReader`.

Implementation:

1. Locate the source file with `PiSessionReader({ sessionsDir, projectPath:
   cwd }).getSessionFilePath(sessionId)`.
2. Build the source branch from the requested anchor (`upToMessageId`) or the
   active leaf (last appended entry) back to root.
3. Write a new Pi session file in the same project session directory, with a new
   session header/id, `parentSession` pointing at the source file, and the
   retained branch re-chained into one self-contained root-to-leaf path. Entry
   ids are preserved, matching Pi's own `createBranchedSession` behavior; only
   the new header and parent links change.
4. Return the new file's id as `{ sessionId }`.

A separate file is *better* than Pi's in-file branch here: the
provider-session-tree doc documents that two Pi runtimes sharing one file
accrete sibling branches (the external-writer hazard,
[session-ownership](session-ownership.md)). A YA fork that emits a distinct file
sidesteps that entirely rather than adding another in-file leaf.

## Relationship to the session-tree proposal

[provider-session-tree](provider-session-tree.md) is the **read** model:
`canReadTree` (enumerate nodes/parent links from durable storage without a
runtime), `canSwitchActivePath`, `canForkAtNode`. `forkSession` here is the
**write** primitive, and **readable tree ≠ forkable**:

- Claude: implements `forkSession` (write) but tree navigation is not
  first-class (read side is weaker).
- Pi: has the richest readable tree (native `id`/`parentId`, `/tree`) and now
  implements `forkSession` by writing a new top-level session file. Active-path
  switching/tree UI is still separate work.
- Codex: models a thread tree (`sessionId`/`forkedFromId`) and now implements
  `forkSession` through native app-server fork/rollback. Tree UI is still
  separate work.

The tree doc's `canForkAtNode` should be defined as "the provider implements
`forkSession` anchored at a tree node id" — i.e. it is satisfied exactly when
this doc's primitive exists and accepts a node-resolved `upToMessageId`. Keep
the two docs in sync: a provider gains `canForkAtNode` only after landing
`forkSession`.

## Summary of gaps

| Provider | Native primitive exists | Wired in YA | Blocking gap |
|----------|-------------------------|-------------|--------------|
| Claude   | yes (SDK `forkSession`) | **yes**     | — |
| Codex    | yes (`thread/fork`)     | **broken from current per-turn UI** | display ids do not address app-server turns; slices remain whole-turn only |
| Pi       | yes (JSONL tree file)   | **yes**     | `/tree` UI / active-path switching remain separate |
