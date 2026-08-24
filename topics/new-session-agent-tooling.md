# New-Session Agent Tooling

> Proposal: launch-time tooling for supervised sessions — shipped YA helper
> scripts on PATH, a capability fragment, a scoped server endpoint channel,
> and options that shape the instruction environment — addressed throughout
> by canonical YA session ids.

Topic: new-session-agent-tooling

Status: direction proposal, 2026-08-24. Nothing is implemented. The
consumer-side story (what the scripts do against the server) is
[`agent-session-access.md`](agent-session-access.md); this topic owns
what YA injects into a session at launch. The one concrete missing
feature — the virgin instruction-scope option — is tracked in
[`gaps/virgin-new-session-option.md`](../gaps/virgin-new-session-option.md).

See also:
[`agent-context-injection.md`](agent-context-injection.md) — current
instruction placement and the dormant personal-launch-integration
sketch this overlaps;
[`ya-env-vars.md`](ya-env-vars.md) and
[`subprocess-environment.md`](subprocess-environment.md) — the injection
channels and namespace contract;
[`session-wake.md`](session-wake.md) — the existing env-published
per-session credential precedent;
[`session-sandboxing.md`](session-sandboxing.md) — the existing
per-session provider-state redirection precedent;
[`ask-session.md`](ask-session.md) — the first planned consumer of the
capability fragment and PATH scripts;
[`vanilla-defaults.md`](vanilla-defaults.md).

## PATH, authority, and tool advertisement

Ship the agent-facing scripts in the `yepanywhere` npm package and, when
the feature is enabled, expose them to supervised sessions through the
channels that already deliver `AGENTCTL_SESSION_ID` and the wake
credential pair: the provider spawn environment (Codex-family) and the
`BASH_ENV` bridge (Claude). PATH extension is one more value on those
existing channels, not a new mechanism. New environment names follow the
`AGENT_*` agent-facing convention; the live publisher migration in
`gaps/agent-facing-env-markers.md` is the naming reference.

The same provider-owned launch step publishes `AGENT_YA_API_URL`, the exact
child-reachable base URL for the originating YA server, and
`AGENT_YA_API_TOKEN`, an ephemeral credential scoped to the shipped agent
session operations. It mints the token for this provider session rather than
passing through an operator login or relying on unauthenticated localhost.
The values are absent when tooling is disabled and are allowlisted through the
same restricted child environment path as the wake pair.

Ordinary Codex `default` and `plan` turns use a network-disabled sandbox
policy. A tool-enabled Codex launch must explicitly set `networkAccess: true`
in the provider service's policy for that session, after resolving a reachable
API URL; it must not flip the default for sessions without agent tooling. A
network-blocked harness may later use a host bridge, but that proposal is not a
prerequisite for the direct tool-enabled Codex launch.

The "prompt saying how to use these tools" is a `[Client capabilities]`
fragment composed by `buildEffectiveAgentContext`
(`agent-context-injection.md`): a short block naming the scripts, the
session's own YA id, and the authority boundary. An MCP server exposing
the same operations is a possible later adapter — the layering rule in
`cross-host-delegation.md` already classifies MCP as one consumer among
REST/CLI/skills — but the capability fragment plus PATH is provider-
neutral and needs no per-harness tool wiring, so it comes first.

Per `vanilla-defaults.md`, all of this ships configurable and
default-off: an out-of-the-box session sees no new PATH entries, env
values, or context fragment.

## Script identity contract

Scripts and fragments identify sessions by canonical YA session id —
which is usually the provider session id — never by provider-native
resume handles (`AGENTS.md` § Provider Session Identity). A session's
own id is already delivered as `AGENTCTL_SESSION_ID`; the fragment
should say so rather than introduce a second name for the same value.

## Instruction-scope options ("virgin" sessions)

A new-session option should let a launch skip the user-global
instruction layer while keeping project instructions, auth, and provider
configuration — a *virgin* session. *Vanilla* remains reserved for unchanged
first-party provider behavior, which normally includes the user's global
instruction layer; this option deliberately removes that layer. The
per-provider mechanics differ:

- **Claude**: the Agent SDK's `settingSources` option already controls
  which filesystem settings tiers load; YA currently passes
  `["user", "project", "local"]` in
  `packages/server/src/sdk/providers/claude.ts`. Virgin drops
  `"user"`. <!-- assumed: that the user tier owns user-global CLAUDE.md
  as well as user settings; probe before implementation -->
- **Codex**: no per-file switch exists; the mechanism is a redirected
  `CODEX_HOME` replica root that omits the user `AGENTS.md`. The
  concrete replica design, auth handling, session discovery, and route
  threading are specified in `gaps/virgin-new-session-option.md`.

The option must persist in session metadata and be reapplied on resume
and fork — like the sandbox `stateKey` — or a resumed session silently
regains the user instruction layer (and, for Codex, loses sight of its
own rollout).

Session sandboxing already redirects `CODEX_HOME`/`CLAUDE_CONFIG_DIR`
per session (`session-sandbox.ts`); a sandboxed virgin session composes
by controlling which instruction files exist in the sandbox provider
state dir, not by double-redirecting.

## Open decisions

- Script naming and prefix (`ya-*` vs a single `ya` multi-command).
- Whether PATH injection and the capability fragment are one toggle or
  independent settings.
- MCP adapter timing (after the scripts prove the surface).
