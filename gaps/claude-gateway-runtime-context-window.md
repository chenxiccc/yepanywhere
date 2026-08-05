# Claude Gateway runtime context can disagree with its model catalog

The Claude Gateway model picker projects the context window advertised by the
gateway's `/v1/models` response. In a live Terra session, that catalog advertised
400,000 tokens while Claude Code's runtime status reported 200,000 through
`contextUsage.contextWindow`.

The mismatch crosses the gateway catalog, Claude Code SDK, and YA runtime-status
boundary, so it was not guessed around during the provider integration. Inspect
which layer clamps or reports the runtime value, then either make that value
authoritative in the picker or clearly distinguish advertised and effective
context windows.

Evidence: profile `claude-gateway-test`, session
`4ff37038-bffc-4b58-b5ef-00e2e45f8a87`.

Found 2026-07-27 while verifying Terra through the Claude Gateway provider.

**Layer identified, corrected mapping awaiting runtime confirmation
(2026-08-05).** Claude Code is the clamping layer: behind
`ANTHROPIC_BASE_URL` it cannot discover a proxied model's limits and gave the
non-Claude `gpt-5.6-sol` model a 200,000-token effective envelope. The first YA
fix set only `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; that controls automatic
compaction but does not enlarge Claude Code's separately resolved model
envelope, so the runtime remained at 200K.

`ClaudeGatewayProvider` now preserves the catalog's total and prompt-only
limits separately. Gateway launches pass total `max_context_window_tokens` as
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` and prompt `max_prompt_tokens` as
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The current default Sol catalog therefore
maps to 400,000 total and 272,000 prompt tokens. Values below Claude Code's
100K automatic-window minimum omit that override rather than exceeding the
model's hard limit. See `topics/resume-compaction.md`.

Keep this entry open until a live non-`claude-*` gateway session reports the
larger effective window and crosses the former 200K boundary successfully. The
change is unit-tested but needs a server restart to affect new provider
processes. Gateway IDs beginning `claude-` remain a separate limitation:
Claude Code ignores the generic maximum-context override for those IDs behind
a custom base URL, so Copilot `claude-opus-5` long context is not yet proven
effective.
