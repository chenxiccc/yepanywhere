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
