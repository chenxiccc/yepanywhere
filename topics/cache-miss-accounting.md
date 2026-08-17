# Cache Miss Accounting

> Cache miss accounting is YA's record of prompt-cache re-reads: for each
> observed turn, how many tokens were billed above the cache-read rate beyond
> what the turn's own new content explains, and how long the session had been
> idle first.

Topic: cache-miss-accounting

Status: implemented 2026-08-17 in
`packages/server/src/services/CacheMissBillingMonitor.ts`, surfaced in
Settings → Cache Billing. Default off. The per-project boot baseline described
under [Session boot](#session-boot) is not built; it is tracked in
[`gaps/cache-miss-boot-baseline.md`](../gaps/cache-miss-boot-baseline.md).

Related topics: [session usage accounting](session-usage-accounting.md) (the
per-session ledger this shares provider facts with),
[prompt cache keepalive](prompt-cache-keepalive.md) (the mechanism that keeps
a cache warm), [provider context economics](provider-context-economics.md),
and [fork from turn](fork-from-turn.md).

## The question it answers

Not "did this turn cost money" but **"how long can a session sit idle before
its prompt cache stops being there"** — measured, per provider, from what the
provider actually reported. A distribution of re-reads against idle time makes
a real cache lifetime visible, separates it from losses that happen seconds
after the previous turn, and puts a token figure on each.

## Provider token semantics differ and must be normalized first

The two wired providers count `input_tokens` incompatibly. Getting this wrong
silently doubles or halves every number downstream.

| | Claude | Codex |
|---|---|---|
| Where usage arrives | nested on the assistant message (`message.usage`) | a synthetic `system` / `token_usage` message, usage at top level |
| `input_tokens` | excludes cached reads and cache writes | **includes** cached reads |
| Cache read field | `cache_read_input_tokens` | `cached_input_tokens` |
| Prompt total | sum of the three input classes | `input_tokens` alone |

Verified against real data on 2026-08-17: a Claude transcript entry reading
`input_tokens: 2, cache_creation_input_tokens: 2324,
cache_read_input_tokens: 78673`, and a Codex rollout reading
`input_tokens: 109340, cached_input_tokens: 108288` — where treating input and
cached as disjoint would claim a 217k prompt in a 258k window.

YA normalizes both into `totalContextTokens` (the whole prompt) and
`uncachedInputTokens` (`total − cacheRead`), and compares only those.

## A continuing turn is expected to pay for its own new content

The expectation is **not** zero uncached tokens. Each turn appends the user's
message plus the previous assistant turn and its tool results, and that new
content is billed as cache writes or fresh input by construction. YA measures
it as growth in total prompt size between consecutive observations — the
provider's own tokens, no local tokenizer, no per-provider constant to tune:

    expected new content = max(0, totalContext(now) − totalContext(previous))
    wasted               = max(0, uncachedInput − expected new content)

`wasted` is the only quantity a threshold may be applied to. Applying one to
raw uncached input instead — as the original implementation did — inverts the
detector: a large pasted message trips it while a genuine recompute in a
smaller session slips under it.

A fork's first turn appends nothing, so its expectation is zero and any
uncached input is waste. Session boot has no previous observation, so it has
no expectation and is never judged.

## Recorded versus flagged

Every miss above the wasted-token floor is **recorded**. Only misses after a
real idle gap are **flagged** (`exception: true`, eligible for a popup).
Within `recentActivityMinutes` — 10 by default — a miss is recorded with
`exception: false` and stays silent: a provider-side shard or serving
migration can drop a warm cache with no YA-visible cause and no YA-available
remedy, so alarming about it trains the operator to ignore the feature. The
observation still counts in the distribution, which is where it is useful.

Clean hits are recorded only once the idle gap reaches that same window. They
are the denominator — a bucket where one turn in twenty missed reads very
differently from one where every turn missed — but back-to-back turns are
never at risk, and recording each would rewrite session metadata on every
assistant message for no analytic gain.

## Defaults

- `minimumWastedTokens` 10,000 — above per-turn noise (breakpoint shuffles,
  re-written trailing segments), well below a prefix recompute worth seeing.
- `recentActivityMinutes` 10 — the "not YA's fault, don't alarm" boundary.
- `providerFreshWindowMinutes` claude 60 / codex 10 — how long YA expects a
  cache to exist at all. Beyond it, no expectation is formed and nothing is
  recorded.

These are calibration guesses, not measurements. The recorded distribution is
what should eventually set them.

## Session boot

A fresh non-forked session's first turn is never judged: there is no previous
observation to size its expected content, and no fork lineage to expect a warm
prefix from. Project boot cost — instructions, skills, tool schemas, reloaded
each time — is therefore invisible to this mechanism. Judging it needs a
baseline per (project, provider, model, effort) built from recent comparable
sessions, since revised instructions, a date rollover, or a changed tree
commit legitimately raise it. Tracked in
[`gaps/cache-miss-boot-baseline.md`](../gaps/cache-miss-boot-baseline.md).
