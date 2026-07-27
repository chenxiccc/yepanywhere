# Claude fronting a Copilot gateway (Architecture B)

> **The SDK-built reference architecture is allowed.** Driving the first-party
> Claude Code harness through a local Anthropic-compatible gateway built on the
> official GitHub Copilot SDK uses officially-supported surfaces on both ends.
> YA now accepts a general operator-supplied gateway URL; that transport
> compatibility does not make a claim about how every third-party gateway
> authenticates upstream. Earlier drafts of this topic contained incorrect
> "must not break ToS" caution about the SDK path; that was wrong and is
> retracted (see the correction note below). This topic scopes Architecture B
> and catalogs the harness gaps that distinguish a Copilot-served model from
> first-party Claude Code.

Topic: copilot-oauth-claude

See also: [`copilot-provider.md`](copilot-provider.md) (the shared "Copilot SDK
is sanctioned for third-party embedding" basis + Architecture C),
[`opencode-copilot.md`](opencode-copilot.md) (Architecture A, near-term plan),
[`claude.md`](claude.md) (the Claude provider contract),
[`prompt-cache-keepalive.md`](prompt-cache-keepalive.md) (the one harness feature
this path still loses).

## Correction (2026-06-21): we are free to do this

Earlier versions of this and sibling topics asserted a "dual terms-of-service
risk" and "no legitimate path," built on a comparison blog and search-result
paraphrases. **That was incorrect.** Verified against primary sources, the
architecture below is sanctioned on both ends; nothing here is a ToS workaround.
Details and citations live in [`copilot-provider.md`](copilot-provider.md) §
"Why this is allowed"; the short version:

- **GitHub:** the official Copilot SDK is *for* embedding Copilot in third-party
  apps/services using each user's own subscription (`COPILOT_GITHUB_TOKEN` / OAuth).
  Individual subscribers fall under Section J; API access "through a third party
  product" is contemplated by the terms.
- **Anthropic:** Claude Code officially documents running against a custom
  `ANTHROPIC_BASE_URL` LLM gateway (Anthropic Messages format), including model
  routing across providers. Using the Claude TUI as the front end is supported.

## Architecture B

```
Claude Code (the harness)
    ↓  Anthropic Messages API  (ANTHROPIC_BASE_URL → localhost; ANTHROPIC_AUTH_TOKEN)
Local Anthropic-compatible gateway, implemented on the GitHub Copilot SDK
    ↓  authenticated Copilot SDK/CLI protocol  (user's COPILOT_GITHUB_TOKEN / OAuth)
GitHub Copilot  →  Opus (and other plan-permitted models)   — allowed
```

The translating component is an operator-supplied gateway. The architecture
originally proposed building that gateway on the **official** Copilot SDK; YA's
provider boundary does not require or inspect a particular implementation, and
the current deployment can instead point at a separately operated compatible
server such as `copilot-api`. YA owns only the Claude Code launch and
Anthropic-compatible boundary, not the gateway's GitHub authentication.

Claude Code requirements the gateway must meet (from the LLM-gateway docs):
expose `/v1/messages` (+ `/v1/messages/count_tokens`), forward
`anthropic-beta` / `anthropic-version` headers, and optionally `/v1/models` for
model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`).

## YA implementation (2026-07-27)

YA now exposes this path as the separately selected **Claude Gateway** provider.
Its URL is configured under the regular Claude provider settings, but regular
Claude is never rerouted:

- Every Claude Gateway process receives a per-launch SDK settings overlay
  (Claude Code's `--settings`/flag layer) plus matching child-only environment
  variables. YA never temporarily edits the user's
  `~/.claude/settings.json`, so manual TUIs and concurrent normal-Claude
  sessions cannot race with gateway selection.
- The gateway's `/v1/models` response is authoritative. Claude Code's own
  `supportedModels()` result is deliberately ignored for this provider because
  a gateway launch still reports first-party Claude choices such as Opus/Fable
  that the gateway may not expose. YA omits disabled, non-chat, and utility
  rows, and does not add regular Claude fallbacks.
- The focused `copilot-api` gateway routes each advertised model through an
  endpoint it actually supports: native Anthropic Messages when available,
  an Anthropic-to-Responses adapter for Responses-only models, and the existing
  chat-completions adapter otherwise. It does not advertise a model through an
  endpoint the upstream catalog lacks. Model-specific gateway failures remain
  on the Gateway transport rather than falling through to regular Claude.
- YA projects per-model context windows and reasoning levels from the gateway
  catalog. When a model advertises reasoning levels, Claude Gateway exposes
  adaptive thinking and the corresponding effort selector; a model with no
  reasoning metadata gets no invented effort control. The focused gateway maps
  Claude's effort request to the chosen upstream endpoint.
- A live end-to-end check on 2026-07-27 launched Claude Code from YA with
  `gpt-5.6-terra` at low effort through the local Responses adapter. The
  completed transcript contains Claude Code `WebSearch` and `WebFetch` tool
  calls plus a sourced final answer, while YA retained
  `provider=claude-gateway` and the Terra model id in canonical session
  metadata.
- Claude Code still owns its transcript compaction and tool-definition
  compaction on this route. Anthropic first-party prompt caching and YA's
  prompt-cache keepalive are not advertised because the Copilot backend does
  not implement Anthropic's cache contract.
- The older `claude-ollama` provider is retained only for compatibility. It is
  hidden when it has never been configured or recorded in session metadata,
  and there is no automatic migration during the deprecation grace period.
  Existing users see a dismissible notice directing them to Claude Gateway.

## Why you'd choose B over A/C

Architecture B is the only one where **Claude Code itself is the harness**, so it
recovers the first-party harness features that OpenCode (A) and a direct YA
Copilot provider (C) lack: Claude Code's modular system prompt, hooks, skills,
Tool Search/tool-definition compaction, effort awareness. You spend the Copilot
budget but keep the Claude Code experience.

**The one feature B still loses: Anthropic first-party prompt caching.** Caching
lives between Claude Code and Anthropic's own endpoint; with a Copilot backend
there is no Anthropic cache. A sophisticated gateway *could* implement its own
cache keyed on the request body (the docs even mention `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
for that), but Copilot's backend is unlikely to honor Anthropic cache-control. So
budget for higher token/latency cost on long sessions. See
[`prompt-cache-keepalive.md`](prompt-cache-keepalive.md).

## Related finding: OAuth into the Claude TUI via env var

Separately useful (and unrelated to Copilot): the Claude TUI accepts a long-lived
OAuth token from **`CLAUDE_CODE_OAUTH_TOKEN`** (generated by `claude
setup-token`, one-year, inference-only), precedence #5 in
[Claude Code's auth order](https://code.claude.com/docs/en/authentication). It
authenticates the user's own **Claude (Anthropic) subscription** — not Copilot —
so it's the clean way to headlessly/remotely auth YA's `claude` provider with a
subscription (no API key, no interactive `/login`). Parked YA idea (belongs in
[`claude.md`](claude.md) if pursued): support `CLAUDE_CODE_OAUTH_TOKEN` /
`apiKeyHelper` for the `claude` provider; `env-filter.ts` already keeps both vars,
so they reach the child today if set — verify and document.

## Harness gaps: OpenCode/Copilot Opus vs first-party Claude Code Opus

Per the user's earlier request — the *quality/feature* differences (not ToS) when
a Copilot-served Opus is reached through OpenCode (A) or a YA Copilot provider (C)
instead of first-party Claude Code. Architecture B closes most of these because
Claude Code is the harness; the model weights are identical in all cases.

- **Prompt caching** — Claude Code's 1-hour TTL + tool-definition caching; absent
  on any Copilot-backed path (the biggest practical gap).
  ([XDA](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/),
  [morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **System-prompt fidelity** — Claude Code's modular 40+ component prompt vs
  OpenCode's own. ([morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **Tool Search / tool-schema bloat** — Claude Code auto-compacts tool defs;
  OpenCode reloads every MCP schema each turn.
  ([morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **Hooks / skills / plugin ecosystem** — richer and faster-moving on Claude Code.
  ([firecrawl](https://www.firecrawl.dev/blog/claude-code-vs-opencode))
- **Copilot-routing specifics** — premium-request quotas; GitHub-controlled model
  versions (note `*-fast` variants); plan/policy gating of Opus.
- **Sentiment caveat** — much 2026 "Claude Code got worse" talk was Claude Code's
  own resolved March–April regressions, not OpenCode superiority.
  ([InfoQ](https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/))

## Bottom line

- **Architecture B is now available in YA** through a configured,
  operator-supplied Claude Gateway.
- It keeps the Claude Code harness while isolating gateway traffic from regular
  Claude sessions, at the cost of gateway operation and the loss of Anthropic
  prompt caching.

## Sources

- [Claude Code Authentication](https://code.claude.com/docs/en/authentication)
  and [LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [GitHub Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- [OpenCode vs Claude Code — morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code),
  [firecrawl](https://www.firecrawl.dev/blog/claude-code-vs-opencode)
- [Anthropic Claude Code quality postmortem — InfoQ](https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/),
  [cache TTL change — XDA](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/)

<!-- epistemic status: primary-source verified 2026-06-21 (Claude Code auth +
LLM-gateway docs; GitHub Copilot SDK auth docs). Earlier "dual ToS / no legitimate
path" framing was incorrect and is retracted: Architecture B is sanctioned on both
ends. Remaining caveats are technical (prompt caching) and empirical (confirm Opus
via the SDK), not ToS. -->
</content>
