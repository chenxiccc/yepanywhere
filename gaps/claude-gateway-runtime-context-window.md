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

**Layer identified, fix landed, runtime confirmation still owed
(2026-08-05).** Claude Code is the clamping layer, and it is documented
behavior rather than a bug in it: behind `ANTHROPIC_BASE_URL` it cannot verify
a proxied model's window, so it budgets the session at 200,000 tokens. That is
the 200,000 the runtime status reported. `ClaudeGatewayProvider` now passes the
catalog's window as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` on every gateway launch,
which should make both numbers describe the same window (see
`topics/resume-compaction.md`).

Keep this entry open until that is confirmed against a live gateway session —
the fix is unit-tested only, and it needs a server restart to take effect. The
same 200K clamp wedged a `gpt-5.6-sol` session at 200,935 tokens with no
compaction anywhere in its transcript, so confirm the compaction point moved,
not just the reported number.
