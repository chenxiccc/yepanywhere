# Cache-Aware Session Bootstrap

> Cache-aware session bootstrap is not a current YA protocol: new sessions
> receive provider-specific agent context with their first real request, with
> no prepared-session pool, readiness marker, or cache-reuse claim.

Topic: cache-aware-session-bootstrap

Status: current absence and startup boundary. The dormant protocol design is
preserved in
[`cache-aware-session-bootstrap.sketches.md`](cache-aware-session-bootstrap.sketches.md).

## Current contract

YA does not run a prepare-only turn before a user's opening request. It does
not keep a per-project boot manager, fork warmed project-ready sessions, parse
an assistant readiness phrase, or expose a project setting for any of those
behaviors. A new session follows the provider placement documented in
[agent context injection](agent-context-injection.md#current-ya-placement).

`buildEffectiveAgentContext` composes enabled client-capability fragments and
free-form global instructions. Provider adapters decide whether that context
is appended to a system prompt or prefixed to the first ordinary user message.
The user's submitted text remains the first task request; no hidden
prepare-only task is assumed to have loaded request-specific policy.

No current telemetry establishes that two new sessions share a byte-identical
provider prefix or receive a prompt-cache discount. Provider, model, effort,
tools, plugins, permissions, endpoint, account, harness version, and dynamic
context can all split cache identity. Cache Billing observations are evidence
about a particular run, not a promise that a prepared lineage exists.

## Boundary for future work

Any future bootstrap mechanism remains a user-visible, configurable,
default-off feature. Before implementation it needs a provider-supported
readiness signal, explicit lifecycle and teardown ownership, stale-instruction
invalidation, and contrastive startup/cost/adherence measurements. It must
fail visibly or use today's cold-start path when readiness or compatibility is
uncertain.

The candidate phase ordering, boot-manager design, cache prerequisites,
possible setting, and open questions live only in the sketches companion.
They are not implementation guidance or approval to add project-local state.

Related current contracts:
[provider-context-economics](provider-context-economics.md),
[session-context-actions](session-context-actions.md),
[fork-from-turn](fork-from-turn.md), and
[prompt-cache-keepalive](prompt-cache-keepalive.md).
