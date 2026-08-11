# Cache-aware session bootstrap

> Cache-aware session bootstrap is a proposed YA protocol that prepares a
> provider session with global and project instructions before the user's
> opening request, then injects YA agent context at a stable pre-request
> boundary and may fork warmed project-ready sessions when provider contracts
> make prefix reuse observable and safe.

Topic: cache-aware-session-bootstrap

Status: **proposal only**. No startup protocol, setting, or boot manager is
approved for implementation.

Related topics: [provider-context-economics](provider-context-economics.md),
[agent-context-injection](agent-context-injection.md),
[session-context-actions](session-context-actions.md),
[fork-from-turn](fork-from-turn.md),
[settings-ui-placement](settings-ui-placement.md), and
[prompt-cache-keepalive](prompt-cache-keepalive.md).

## Motivation

YA currently composes optional agent-context hints with global instructions
through `buildEffectiveAgentContext`. Provider placement, resume coverage,
visible-versus-provider transcript behavior, and native compaction durability
differ. The current matrix and evidence live in
[agent context injection](agent-context-injection.md#current-ya-placement).

The proposed protocol separates three phases that are conflated today:

1. **Project bootstrap.** Ask the agent to read the applicable global and
   project `AGENTS` material, perform required boot preparation, and become
   ready for a project-configured request class. Do not include the user's
   opening request yet and do not permit task-specific implementation.
2. **YA context.** Add enabled YA capability/instruction fragments after the
   prepared project prefix but before the request.
3. **Opening request.** Deliver the user's actual first turn verbatim.

This ordering could preserve one byte-identical, project-specific prefix across
many new sessions while allowing YA's own optional fragments and the user's
request to vary later in the prompt. It also gives Settings a concrete answer
to where agent-context fragments enter the session.

The mode is optional per project. Its prepare-only turn defaults to “get ready
for a research or implementation request to follow”; a project may supply a
narrower stable request class. That class participates in the manager's cache
lineage and cannot stand in for request-dependent policy activation.

## Cache hypothesis and prerequisites

The hypothesis is plausible, not established. A later placement can increase
cache reuse only when all prompt bytes and cache-routing inputs before that
placement remain identical and fresh. Provider, model, effort/thinking mode,
system prompt, tool inventory, MCP/plugin state, permission policy, endpoint,
account, cache key, and retention policy can all split the cache family.

The useful unit is therefore one project/provider/configuration lineage, not a
universal YA boot cache. A provider-specific injection that YA cannot disable
or move may already vary the prefix before the proposed boundary and erase the
benefit. Providers that expose neither reliable cached-token accounting nor a
prefix-preserving fork contract cannot justify cache-savings claims.

Any experiment must compare current startup against the proposed protocol and
record:

- first-request latency and total startup latency;
- uncached, cache-creation, and cache-read input tokens where available;
- the exact fields used to declare two prefixes cache-compatible;
- warm, expired-cache, same-project, and cross-project cases; and
- the extra agent turn and transcript bytes spent reaching readiness.

No default may be promoted on latency intuition alone. An additional boot turn
can cost more than it saves when the cache misses or the request would have
needed little project reading.

## Readiness boundary

Tool activity that looks like instruction reading is not a protocol signal.
The provider-neutral version needs an explicit, machine-readable readiness
boundary after required instruction discovery has completed. A prose phrase
parsed from arbitrary agent output is insufficient; it can collide with normal
text or be omitted.

Candidate boundaries for later validation:

- a YA-owned structured completion marker requested by the bootstrap turn;
- a provider-native initialization hook or lifecycle event, where one exists;
- a bounded bootstrap action whose terminal assistant turn is itself the
  boundary.

Failure to reach readiness must fail visibly or fall back to the current
startup contract. YA must not silently send the real request into an uncertain
half-bootstrapped state.

## Boot manager and fork variant

A stronger variant keeps one **project boot manager** per compatible
project/provider/configuration lineage. The manager reaches the readiness
boundary without receiving user work. Each actual request starts from a
provider-native fork of that prepared prefix, receives enabled YA context, then
receives the user's opening request.

The exact protocol template and its task-transition boundary are specified in
[prepare-only boot manager](agent-context-injection.md#prepare-only-boot-manager).

This variant is eligible only when the provider guarantees that the fork keeps
the rendered prefix byte-identical and YA can verify the fork's cached-token
behavior. Native fork capability does not imply safe parallel worktree
mutation: session isolation, ownership, and concurrent-edit policy remain
separate constraints. The manager itself should be read-only after bootstrap.

This project-ready manager cannot preload policy files selected only after a
real request is known. The complementary
[request-conditioned boot compiler](agent-context-injection.md#request-conditioned-boot-compiler)
can compile the full activated policy set into a task-bound Codex AGENTS
snapshot before the real task session starts. The later
[protected compaction capsule](agent-context-injection.md#protected-compaction-capsule)
can retain an active request's load-bearing intent and activated scoped policy
at an explicit later boundary. It is replaceable current-task state, not a
template for unrelated requests.

The manager must not become an invisible permanent keepalive. Creation,
retention, expiry, refresh, and teardown need explicit bounded ownership under
[prompt-cache-keepalive](prompt-cache-keepalive.md). A cold or incompatible
manager is merely a reusable transcript prefix, not a claimed warm cache.

## Possible project setting

A future per-project option could enable prepare-only boot reuse and set its
stable request class, defaulting to `research or implementation`. The global
default remains off. The UI must show the exact boot prompt, provider-specific
placement, manager/fork lifecycle, restart/new-session scope, and any synthetic
transcript turns before the user enables it. The current LaTeX capability
toggle is the motivating context-placement instance; this proposal does not
add the project option now.

## Open decisions

- Which providers can expose a reliable readiness boundary without transcript
  scraping?
- Does the bootstrap turn become visible in the conversation, or a separately
  labeled YA protocol turn?
- Can current provider-native instruction injection be moved or disabled
  without losing provider guarantees?
- Is one manager keyed by project/provider/model sufficient, or do tools,
  permissions, effort, endpoints, and other launch fields require finer keys?
- How are changed `AGENTS` files detected so no fork inherits stale project
  instructions?
- Which activated scoped policy files require exact reconstruction after
  compaction, and which should instead be reread at their next action trigger?
- What measured hit rate and saved input cost repay the extra boot turn,
  manager lifecycle, and user-facing complexity?
