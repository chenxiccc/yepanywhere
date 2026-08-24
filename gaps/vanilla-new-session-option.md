# New session lacks a "vanilla (skip user AGENTS.md)" option

Missing feature: a new-session launch option that gives the agent a
provider-default instruction environment — no user-global
`AGENTS.md`/`CLAUDE.md` layer — while keeping project instructions,
auth, and provider configuration. Wanted so agent-tool and steward
launches (`topics/new-session-agent-tooling.md`) can start workers that
are not conditioned by the operator's personal instruction corpus.

Opt-in per launch, default unchanged (vanilla-defaults; the option name
deliberately reuses "vanilla" in that topic's provider-default sense).

## Per-provider mechanism

- **Claude**: drop `"user"` from the `settingSources` array YA passes to
  the Agent SDK (`packages/server/src/sdk/providers/claude.ts` currently
  hardcodes `["user", "project", "local"]` at both call sites). SDK docs
  say `"project"` must stay for project CLAUDE.md loading. Probe before
  implementation that the user tier covers user-global CLAUDE.md, not
  only user settings.
- **Codex**: no per-file switch; redirect `CODEX_HOME` to a reused
  replica root, e.g. `{dataDir}/codex-vanilla` (per-profile isolation
  for free), containing:
  - `auth.json` symlinked to the real `~/.codex/auth.json`, or
    copied-when-modified (freshness check at each launch). Verify how
    Codex rewrites `auth.json` on token refresh first: an atomic
    rename-replace through a symlink would turn the replica copy into an
    independent regular file and fork credentials, which favors the
    copy-on-launch form.
  - `config.toml` symlinked or copied the same way (model/provider/MCP
    config is not the layer being removed).
  - no user `AGENTS.md` — the point of the replica.
  - `sessions/` as a real directory: vanilla rollouts land here.

## Session discovery for the replica root

`codex-scanner.ts` derives one scan root (`CODEX_DIR`,
`CODEX_HOME ?? ~/.codex`; `CODEX_SESSIONS_DIR` override exists). The
replica is YA-owned at a well-known path, so teach the Codex scanner to
include it as a second root whenever it exists. That also discovers
sessions started *outside* YA by agent tools that exported
`CODEX_HOME={dataDir}/codex-vanilla` themselves. Alternative: symlink
the replica's `sessions/` back to the real root so every rollout lands
in one store and the scanner needs no change — simpler, but symlink
semantics on Windows make the two-root scan the portable design
(`AGENTS.md` § Cross-Platform Behavior And Tests).

## Setting it in the new-session route

Thread it exactly like `sandboxLevel`, the existing per-session
provider-environment option:

1. Add an optional field to `StartSessionBody` (e.g.
   `instructionScope?: "standard" | "vanilla"`), parsed and validated at
   the route boundary in `routes/sessions.ts` beside
   `parseSessionSandboxLevel`, on both the project-scoped and
   project-inferring create routes.
2. Pass it through `Supervisor.startSession` model settings the way
   `sandboxLevel`/`sandboxStateKey` travel today.
3. Apply it in the provider adapters: Claude filters `settingSources`;
   Codex sets `CODEX_HOME` to the replica in the child spawn env (after
   ensuring/refreshing the replica). Precedent:
   `session-sandbox.ts` already sets `sandboxEnv.CODEX_HOME =
   providerStateDir` for sandboxed sessions; a sandboxed vanilla launch
   composes by omitting user instruction files from the sandbox state
   dir rather than double-redirecting.
4. Persist the choice in session metadata and reapply on resume and
   fork, or a resumed Codex session loses its rollout root and a
   resumed Claude session silently regains the user layer.
5. Client compatibility: the field is additive; the shipped client
   needs the normal `server-capabilities.md` review before sending it.

Why not fixed in place: feature work spanning the route boundary,
Supervisor threading, two provider adapters, the Codex scanner, and
replica lifecycle/auth handling — far beyond the topic-authoring change
that surfaced it.

Found 2026-08-24 while writing `topics/new-session-agent-tooling.md`
and `topics/agent-session-access.md`.
