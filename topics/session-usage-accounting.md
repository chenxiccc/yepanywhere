# Session Usage Accounting

> Session usage accounting is YA's proposed per-session token ledger — summed
> from provider transcripts, split by cost class and by whether the call was a
> subagent — surfaced as a trailing-window burn rate and a session total beside
> the existing subscription-quota view.

Topic: session-usage-accounting

Status: **proposal, mostly not implemented** as of 2026-08-17. The
provider-side facts below were verified against a live copilot-api gateway and
the Claude Code 2.1.220 transcript schema on 2026-08-06. The aggregation
service — burn rate, session total, main/subagent split — is still unbuilt.
One piece of the client surface now ships: the context indicator's left-click
popover lists the *last turn's* reported classes (context total, cache read,
cache write, output) from the `ContextUsage` the session summary already
carries, in `packages/client/src/components/ContextUsagePopover.tsx`. That is
a single-turn readout, not a ledger, and it applies no price weighting.

Related topics: [provider subscription usage](provider-subscription-usage.md)
(the account-quota view this sits beside),
[provider context economics](provider-context-economics.md) (why replay and
cache prefixes cost what they do), [cost efficiency](cost-efficiency.md),
[prompt cache keepalive](prompt-cache-keepalive.md), and
[Claude fronting a Copilot gateway](copilot-oauth-claude.md).

## Motivation

YA already shows two numbers that people mistake for a third one it does not
show. Context percentage is *how full this session's window is*; subscription
usage is *how much of the account's rate-limit window is gone*. Neither
answers "what is this session actually spending, and how fast" — the question
that decides whether to let a long agent run continue, and the one that makes
a runaway subagent fan-out visible before the quota window closes.

## The ledger already exists: provider transcripts

For Claude — including every `claude-gateway` session, because the harness
there is still Claude Code — the per-call record lives in the session JSONL
under `{CLAUDE_CONFIG_DIR}/projects/<encoded-cwd>/<session-id>.jsonl`. Each
assistant entry carries `message.usage` with the four token classes YA already
models in `packages/shared/src/claude-sdk-schema/message/AssistantMessageSchema.ts`:
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and
`cache_read_input_tokens`.

Subagent attribution needs no new provider work either. `isSidechain` is on
the base entry schema (`packages/shared/src/claude-sdk-schema/entry/BaseEntrySchema.ts`);
`packages/server/src/augments/message-utils.ts` already treats `agentId` plus
`isSidechain` as the subagent marker for SDK 0.2.76+; and
`packages/server/src/sessions/reader.ts` already parses `spawnDepth` and
`agentType` per delegated unit. Grouping "was this call a subagent" is a fold
over records YA reads today.

One existing consumer must not be reused for this. `getTotalInputTokens` in
`reader.ts` sums all three input classes deliberately, because *context fill*
counts every token in the window regardless of price. A cost or burn-rate
figure that reuses it silently prices a cache read at the rate of a fresh
input token.

## The four classes are not interchangeable

Against metered Anthropic pricing the reference multipliers on base input are:
output ≈ 5×, 5-minute cache write ≈ 1.25×, 1-hour cache write ≈ 2×, cache read
≈ 0.1×. So cached reads are cheap but **not** free — at a 90 % cache-hit ratio
the reads still land in the same order of magnitude as the fresh input they
displaced. Any weighting YA applies belongs in configuration read at runtime,
never as a constant compiled into a display component; prices change without
notice and a stale hardcoded table is worse than showing raw classes.

`packages/server/src/services/CacheMissBillingMonitor.ts` already watches the
read/creation ratio for billing anomalies and is the natural place to share a
classifier with.

## What the gateway adds, and what it does not

Verified 2026-08-06 against `~/copilot-api` at `127.0.0.1:4141`:

- copilot-api populates all four Anthropic token classes on every route it
  serves. On `/v1/messages` (Claude models) the upstream response is forwarded
  untouched. On `/responses` and `/chat/completions` the translations in
  `src/routes/messages/{responses,stream,non-stream}-translation.ts` synthesize
  `cache_read_input_tokens` / `cache_creation_input_tokens` from OpenAI's
  `cached_tokens` / `cache_write_tokens`, and subtract them out of
  `input_tokens`. A gateway session's JSONL is therefore as complete a ledger
  as a native one.
- copilot-api keeps **no** per-request usage log of its own. Request and
  response payloads go to `consola.debug` on stdout only, and
  `~/.local/share/copilot-api/` holds just `github_token`. There is no file to
  reconcile against; the Claude JSONL is the single source.
- Its `/usage` route returns the account-level GitHub Copilot quota snapshot —
  `quota_snapshots.premium_interactions` with `entitlement`, `remaining`,
  `percent_remaining` — i.e. **premium requests, not tokens**.

That last point sets the honest framing for gateway sessions: tokens there
measure context and throughput, not money. The billed unit is the premium
interaction, which is exactly the shape
[provider subscription usage](provider-subscription-usage.md) already
normalizes. A gateway burn rate must not be presented as spend.

## Proposed contract

- **Read-only, no extra provider work.** The aggregation folds over transcript
  records YA already reads. It never issues a provider call, never creates a
  turn, and never inflates a session's own usage to measure it.
- **Four classes preserved end to end.** The server returns the classes
  separately per group; collapsing to one number is a display choice made with
  an explicit, configured weighting, not in the reader.
- **Two groups: main and subagent.** Split by the existing sidechain/`agentId`
  marker, with `spawnDepth` retained so a nesting blow-up is visible rather
  than folded into one "subagent" bucket.
- **Trailing window is wall-clock, from completed calls.** The 10-minute rate
  uses entry timestamps and only entries that carry a final `usage`; an
  in-flight turn contributes nothing until it settles. An idle session decays
  to zero rather than freezing at its last value.
- **Absent data shows nothing.** Providers whose transcripts carry no per-call
  usage get no burn UI. YA does not estimate tokens it was not told.
- **Never conflated with context fill or subscription quota.** Three distinct
  numbers, three distinct labels, in the one place they are read together.

## Proposed client surfaces

The context indicator's left-click dialog already opens the applicable
subscription windows (see
[provider subscription usage](provider-subscription-usage.md) § Client
surfaces; right-click / long-press stays the compact-threshold editor) and,
since 2026-08-17, the last turn's raw token classes. It now opens for sessions
with no subscription windows at all, since those still report token classes.
This proposal adds to that dialog, beside "% quota remaining":

- **Burn (10 min)** — read and write rates, main and subagent.
- **Session total** — the same split, cumulative.

The context tooltip carries a compact one-line form of both, so the numbers
are reachable without opening a dialog.

An **optional bottom-bar status text**, default off, shows the 10-minute rate
and session total continuously for people running long unattended work. Off by
default: the existing bar is not crowded by accident, and this is a preference,
not a defect in what is there now.

## Open questions

- Does the 10-minute window belong to the session or to the project? A
  fan-out of subagents is a session fact; competing sessions on one account
  are what actually exhausts the quota window.
- Should the weighting be a per-provider price table (money) or a fixed
  read/write split (throughput)? The gateway's premium-request billing argues
  for showing classes and rates plainly, and reserving money to providers that
  really bill per token.
- Codex, Gemini, Grok, and OpenCode transcripts each report usage differently;
  `packages/server/src/sdk/providers/opencode.ts` already aggregates a
  four-class shape. Whether one normalized `SessionUsage` covers all of them is
  unproven.
