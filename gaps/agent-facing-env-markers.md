# Agent-facing environment outputs still use YA product names

YA's namespace contract says `YEP_*` / `YA_*` is product configuration and
`AGENT_*` is state addressed to an agent or launcher-independent tool. Six live
child-session outputs still violate that split. They are not ordinary inherited
leaks: `filterEnvForChildProcess` drops product-prefixed input by default, while
provider overlays, an explicit browser-debug allowlist, and the late `BASH_ENV`
bridge deliberately reintroduce these exact values.

The current names and collision-resistant replacements are:

| Current output | Canonical output | Semantic reason |
|---|---|---|
| `YEP_SESSION_WAKE_URL` | `AGENT_SESSION_WAKE_URL` | Opaque endpoint scoped to the supervised session's wake capability. |
| `YEP_SESSION_WAKE_TOKEN` | `AGENT_SESSION_WAKE_TOKEN` | Bearer factor paired with that session-specific endpoint. |
| `YEP_BROWSER_DEBUG_AGENT_URL` | `AGENT_BROWSER_DEBUG_BROKER_URL` | Names the diagnostic broker role rather than the vague recipient `AGENT`. |
| `YEP_BROWSER_DEBUG_CALLER_TOKEN` | `AGENT_BROWSER_DEBUG_CALLER_TOKEN` | Preserves the protocol's caller-factor distinction from the separately pasted per-tab grant. |
| `YEP_CLAUDE_GATEWAY=1` | `AGENT_LAUNCH_ROUTE=claude-gateway` | Route is distinct from the `claude` harness and from the backend implementation. |
| `YEP_COPILOT_API=1` | `AGENT_LAUNCH_BACKEND=copilot-api` | Backend identity is an explicit catalog handshake, not a route, model, vendor, URL, or port inference. |

Do not shorten these to an ambiguous `AGENT_SESSION_ID`, `AGENT_WAKE_*`, or
`AGENT_BACKEND`. The names must remain safe in non-YA shells where unrelated
launchers and tools share the `AGENT_*` namespace. Keep `AGENTCTL_SESSION_ID`:
it identifies the established coordination consumer and avoids colliding with
provider-native or broker session ids. Keep `YEP_ORIGINAL_BASH_ENV` and
`YEP_PROVIDER_HOST_RUNTIME_DIR`: they are YA-private bridge/host machinery, not
semantic values an agent is expected to consume. Keep operator configuration
such as `YEP_SESSION_WAKE_BASE_URL` product-prefixed for the same reason.

## Compatibility migration

The 2026-08-17 `YEP_AGENT_*` launch-marker rename needed no shim because those
values were filtered before any intended reader could observe them. These six
outputs have live readers, so migrate them reader first:

1. Teach readers to prefer a complete canonical pair/value and accept the
   complete legacy pair/value as fallback. Never combine one canonical wake or
   browser value with one legacy value.
2. Dual-publish canonical and legacy names at every YA boundary: launch worker,
   remote environment, Claude flag-settings overlay, direct child environment,
   browser-debug allowlist, and atomic Bash bridge. Delete stale values in both
   namespaces before republishing target-session values.
3. Move in-repo readers and generated instructions to canonical names:
   `SessionWakeService`, `BrowserDebugService`, the browser-debug CLI,
   `browserDebugLease`, provider/bridge tests, and the contracts in
   `topics/session-wake.md`, `topics/remote-browser-diagnostics.md`,
   `topics/claude.md`, and `topics/copilot-oauth-claude.md`.
4. Retain legacy aliases for out-of-repo harness/tool consumers through a stated
   compatibility window. Record the decision in `topics/backward-compat.md`.
   Remove aliases only after the supported consumer set no longer needs them.

The sibling `~/agents` repository owns the reader-side inventory and fresh-child
cleanup in `topics/AGENT_ENV_VARS.md`, `agentctl_plugins/wake.py`, and
`scripts/session-turn`. YA remains the publisher authority.

## Tests required to close the gap

- The shared filter still drops arbitrary inherited `YEP_*` / `YA_*` values;
  only intentional compatibility aliases survive or are injected later.
- Launch route/backend tests cover canonical publication, legacy publication,
  canonical precedence, URL-change clearing of backend identity, and absence
  without the explicit catalog handshake.
- Wake and browser bridge tests cover initial spawn, later atomic publication,
  resume, stale-value deletion in both namespaces, quoting, and prior
  `BASH_ENV` chaining.
- Browser-debug CLI and copied-instruction tests use canonical names while
  accepting the legacy pair during the compatibility window; neither token
  reaches logs, persisted diagnostics, or generated examples.
- Remote-provider tests prove the same names and values cross only supported
  explicit child-reachable boundaries.

This was not fixed in place because changing all publishers and live readers is
a compatibility migration, while the adjacent cross-repository defect is the
fresh-child boundary. No YA server restart is required to land this gap and its
current-contract clarification.

Found 2026-08-17 while reconciling the cross-repository harsh-review blocker for native session-turn environment isolation.
