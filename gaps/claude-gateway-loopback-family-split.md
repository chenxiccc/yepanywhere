# A spawned Claude process re-resolves the gateway hostname on its own

YA's own catalog read is now pinned: `resolveClaudeGatewayEndpoint`
(`packages/server/src/sdk/providers/claude-gateway-launcher.ts`) returns the
address that answered, and `getAvailableModels` fetches from exactly that address.
The session path is not. `gatewayEnvironment`
(`packages/server/src/sdk/providers/claude-gateway.ts`) passes the configured URL
straight through as `ANTHROPIC_BASE_URL`, so the spawned Claude Code process
resolves the hostname itself and can reach a different server than the one YA
probed.

That matters because a server binding one address family leaves the other family's
socket free on the same port — no `EADDRINUSE`, no warning. Observed: two
`copilot-api` processes held port 4141 at once, one on `127.0.0.1` and one on
`[::1]` five days older, serving different model catalogs (each snapshots its
catalog at boot). A session could therefore run against a different gateway than
the model list came from.

Not fixed with the catalog read because `getSettings`/`getEnv` are synchronous and
cannot probe, so pinning here means either caching the last resolved address on the
provider — stale by session-launch time — or making launch preparation async. Both
are larger than the seam that was open.

Workaround meanwhile: configure `claudeGatewayUrl` as an explicit address
(`http://127.0.0.1:4141`) rather than `localhost`, which leaves the child nothing
to resolve.

Found 2026-08-05 while fixing the probe/fetch half of the same defect.
