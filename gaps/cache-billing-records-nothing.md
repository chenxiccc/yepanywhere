# Cache Billing can never record an event, for two independent reasons

The Cache Billing settings pane (Settings → Cache Billing,
`packages/client/src/pages/settings/CacheMissBillingSettings.tsx`) offers a
"Track Cache Accounting" toggle, per-provider fresh windows, a "Minimum
Uncached Input" size, and two event columns. Both columns are permanently
empty: `CacheMissBillingMonitor` rejects every real provider message before it
can classify one. Enabling the toggle changes nothing.

## What the controls mean today

`packages/server/src/services/CacheMissBillingMonitor.ts:204` classifies a turn
only when YA already expects a free cached prefix — the session is a fork on
its first usage-bearing turn, or a warm turn inside the provider window
(`:187`). The classifier is a strict dichotomy over
`uncachedInputTokens = input_tokens + cache_creation_input_tokens` (`:99`):

- `cacheRead > 0 && uncached < minimumInputTokens` → "expected-cache-hit"
- `cacheRead == 0 && uncached >= minimumInputTokens` → "unexpected-recompute"
- anything else → no record at all

So "Minimum Uncached Input" (default 50,000 —
`packages/shared/src/types.ts:196`) is a noise filter on the *raw* uncached
count: below it a cache-less turn is dismissed as too small to care about,
above it a cache-hit turn is not credited as a success. Both meanings are
wrong under the corrected contract below, and the third branch silently
swallows the most interesting case: a turn that *did* read cache but also
recomputed a large prefix records nothing either way.

## Why nothing is ever recorded

**1. Claude's usage is nested; the extractor reads it flat.**
`extractCacheMissBillingObservation` requires `message.type === "assistant"`
(`:81`) and then reads a top-level `message.usage` (`:84`). The Agent SDK's
`SDKAssistantMessage` (`@anthropic-ai/claude-agent-sdk/sdk.d.ts:2929`) has no
top-level `usage` — the four token classes live in `message.message.usage`,
which is also where the on-disk transcript carries them. `convertMessage` in
`packages/server/src/sdk/providers/claude.ts:2359` passes SDK fields through
untouched, so nothing hoists it. Every Claude assistant message returns
`undefined`. Note `extractPromptCacheRefreshUsage` in the same provider file
(`:450`) already handles all three locations (`usage ?? modelUsage ??
message.usage`) — the monitor just never adopted that.

**2. Codex's usage never arrives on an assistant message.** Codex reports token
usage on a synthetic `type: "system"`, `subtype: "token_usage"` message
(`packages/server/src/sdk/providers/codex.ts:4185`) whose `usage` *is*
top-level. The `type !== "assistant"` guard rejects it. So the extractor's
shape check matches Codex's location but Claude's type, and its type check
matches Claude's type but Codex's location; neither provider satisfies both.

Those are the only two wired providers
(`CACHE_MISS_BILLING_PROVIDERS`, `:17`); the other eight are unwired by design.

**Why the tests pass.** `assistantMessage()` in
`packages/server/test/services/CacheMissBillingMonitor.test.ts:43` builds
`{type: "assistant", usage}` — a hybrid shape no provider emits. The unit
tests validate the classifier against a fixture that cannot occur.

**Aggravating, not causal:** the feature is default-off
(`DEFAULT_CACHE_MISS_BILLING_SETTINGS.enabled === false`) and this host's
`server-settings.json` has no `cacheMissBilling` key at all, so on this machine
it was never even armed. That alone would explain an empty log; the two shape
mismatches are why arming it would not have helped.

## Also out of scope by construction: session boot

Even with extraction fixed, a fresh non-forked session's first turn is never
evaluated: `warmExpected` needs a prior usage observation in the same process
or a recorded prompt-cache refresh, and `forkExpected` needs fork lineage
(`:169-186`). Project-boot cost — the uncached load of AGENTS/CLAUDE.md
instructions, skills, and tool schemas, which is exactly the recurring cost
worth watching — is outside what this mechanism was built to see.

## The expected-cost contract is wrong, not just unwired

`ExpectedInputCostState` hardcodes `expectedUncachedPrefixTokens: 0`. That is
false for any window-extending turn. On a normal continuing turn the new
content since the cached prefix — the user's message, plus (provider- and
harness-dependent) the previous assistant turn and its tool results, plus any
rewriting the harness applies — is *expected* to be billed as cache write or
fresh input. A real turn from this project's transcript:

    input_tokens: 2, cache_creation_input_tokens: 2324,
    cache_read_input_tokens: 78673

YA scores that as `uncachedInputTokens = 2326`. Under a zero-expectation model
those 2326 tokens look like a (small) violation; in fact they are the expected
price of appending the turn. Scale it up and the filter inverts: paste a 60k
token message into a perfectly warm session and it trips
"unexpected-recompute", while a genuinely wasteful 40k full recompute in a
smaller session records nothing.

The contract should instead be:

- **Expected uncached ≈ k × (new content since the cached prefix)** — the user
  turn's tokens, plus the previous assistant turn/tool activity where the
  provider folds it in. Per-provider `k`, measured rather than assumed.
- **The slop threshold applies to the excess over that expectation, never to
  the expectation itself.** The user turn's own tokens are expected cache
  misses by construction; a "minimum" that hides them hides nothing useful and
  a "minimum" that counts them manufactures false violations.
- **Boot cost gets a historical baseline instead of a fixed expectation.** If a
  YA session was created for the same (project, provider, model, effort) within
  a provider-specific recency window, compare this session's *initial*
  (pre-user-request) uncached input against that history; flag only an excess
  over the historical norm. Revised AGENTS instructions, a date rollover, and —
  for some harnesses — a changed tree commit legitimately raise it, which is
  discoverable by analysing the recorded series rather than guessing at it.
- **Keep the third branch.** Partial recompute (cache read > 0 *and* a large
  unexpected write) is a real outcome and currently the silent one.

## Cheap first fix

Independent of the contract redesign, extraction is a small correction: read
`usage ?? message?.usage ?? modelUsage`, accept the Codex `token_usage` system
message alongside assistant messages, and rebuild the unit fixtures from real
captured provider messages instead of the hybrid literal. That makes the
mechanism observable, which is the prerequisite for measuring `k` and the
per-combination boot baselines the corrected contract needs. Not fixed in place
because the classifier those observations feed is itself wrong, and the
maintainer asked for diagnosis and a written plan first.

`topics/server-performance-observability.md` § Cache-event distinctions already
records the symptom (profuse Codex entry-cache misses while Cache Billing never
surfaces an outcome) and proposes stage counters — usage-bearing message seen,
expected-warm entered, usage fields absent, threshold left it unclassified,
record emitted. Those counters would have named this within one session and
should land with the fix.

Found 2026-08-17 while answering what "Minimum Uncached Input" is for and
adding the per-turn cache readout to the context-usage popover.
