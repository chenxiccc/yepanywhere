# Cache Miss Accounting

> Cache miss accounting is YA's record of prompt-cache re-reads: for each
> observed turn, how many tokens were billed above the cache-read rate beyond
> what the turn's own new content explains, and how long the session had been
> idle first.

Topic: cache-miss-accounting

Status: implemented as of 2026-08-21 in
`packages/server/src/services/CacheMissBillingMonitor.ts`, surfaced in
Settings → Cache Billing. Default off. The idle-gap boundary distinguishes
human from automatic provider turns, and mixed-version support keeps the
legacy recent-activity meaning while gating the additive ignore-after field.
The per-project boot baseline described under [Session boot](#session-boot) is
not built; it is tracked in
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

A continuing-turn sample's idle gap starts at the previous usage-bearing
assistant observation and ends when the next real human message is yielded to
the provider. It therefore excludes the provider's work on the new turn. A
reload-safe worker that predates yield reporting temporarily uses server receipt
of the human message; a current worker replaces that fallback with the provider
boundary before usage arrives. Automatic heartbeat, wake, and project-queue
turns advance the warm-prefix baseline but never create cache evidence or
popups. Additional provider requests within the same human turn have no human
idle interval and occupy the zero end of the 0–10 minute bucket. Only the first
provider request after a human message is a complete human-turn probability
sample.

Within the provider freshness window, every measurable clean hit and every
miss above the wasted-token floor is **recorded**. Clean hits are the
denominator: a duration bucket where one turn in twenty missed means something
different from one where every turn missed. The legacy recent-activity window
records a miss but does not flag it (`exception: false`) or show a popup; its
default is 10 minutes. Later eligible misses are flagged because they represent
an unexpected recompute after local activity has settled.

The optional ignore-after cutoff excludes both hits and misses beyond its
duration so the event list, totals, and probability denominators describe the
same population. Zero means no additional cutoff beyond the provider freshness
window. It is serialized separately as `ignoreAfterMinutes` and exposed only
when the server advertises `cache-miss-billing-ignore-after`. Without the
capability, the client keeps the legacy recent-activity control and omits the
new field from writes and undo restores.

The UI's separate recency filter limits records by event timestamp. Its 1–96h
slider ends in an unlimited notch, and a blank numeric value also means
unlimited. The visible summary, all charts, provider/model hover contents, and
grouped wrapping table consume that same explicitly filtered event set. A
finite window is repeated beside the table row count; unlimited adds no suffix.
Duration buckets double from `0–30s`, `30s–1m`, `1–2m`, and onward with no
terminal cap, so short cache lifetimes remain visible without losing the long
tail. The charts omit ranges containing no observations.

The table adds a browser-local result filter, defaulting to misses and
persisting Misses / Hits / All across revisits. It does not filter the charts:
clean hits remain the denominator for miss probability even when the table is
showing misses only. Table columns distinguish when YA recorded an event
(`Seen`) from its measured human-turn delay (`Gap`). Rows from one session
share a color marker, while clicking a numbered `Msg` jumps to the next older
visible event from that session; the full provider id remains available on
hover.

## Design decisions

- **Keep hit/miss filtering table-local** (versus filtering every evidence
  view): the table is a row-browsing surface, while the probability charts
  require retained hits as their denominator.

## Defaults

- `minimumWastedTokens` 10,000 — above per-turn noise (breakpoint shuffles,
  re-written trailing segments), well below a prefix recompute worth seeing.
- `recentActivityMinutes` 10 — record short-delay misses for the distribution,
  but do not flag them or show popups.
- ignore-after 0 — do not impose another measurement cutoff inside the
  provider freshness window.
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
