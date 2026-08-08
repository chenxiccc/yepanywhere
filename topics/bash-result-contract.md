# Bash Result Contract

> Provider-normalized Bash results should carry canonical structured command
> output metadata so renderers can show output, empty-output state, return code,
> and timing without provider-specific text heuristics.

Topic: bash-result-contract

See also: [stream-persisted-render-parity](stream-persisted-render-parity.md)
(the equivalence contract this normalizer would enforce structurally — a
provider-base Bash normalizer is that topic's "provider-normalizes direction"),
[provider-authoring](provider-authoring.md).

Status: proposal. The immediate UI path may use best-effort parsing, but the
durable fix belongs in provider normalization.

## Problem

Bash/Ran rendering wants the same facts across providers:

- stdout/stderr text, after provider envelope removal.
- empty-output state, distinct from missing result data or interrupted output.
- return code, especially non-zero `rc=N` when output is empty.
- wall time or duration when the provider exposes it.
- interruption/background state.

Today those facts are partly normalized for Codex command-execution replay and
partly inferred in the client from strings such as `Process exited with code`
or `Exit code:`. That works for common traces, but it scatters provider
knowledge into UI renderers and leaves each new harness to rediscover envelope
rules.

## Proposed Contract

The canonical structured Bash result should remain backward-compatible and
additive:

```ts
interface BashResult {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isImage?: boolean;
  backgroundTaskId?: string;
  exitCode?: number;
  wallTime?: string;
}
```

Provider adapters normalize their own raw tool/end-event shapes into this
contract before the client sees them. The client renderer should prefer these
fields and treat raw text parsing as compatibility fallback only.

Accepted provider input variants should be provider-local, but common cases are:

- `exitCode`, `exit_code`, `returnCode`, `return_code`, or `rc` → `exitCode`.
- `Wall time: ...` / provider duration fields → `wallTime`.
- `Output:\n...` envelope sections → stdout/stderr content without the envelope.
- `Process exited with code N` / `Exit code[:] N` in legacy strings →
  `exitCode`.
- Claude failure strings may prefix that status with `Error:`. A bare status
  line is envelope metadata only when the tool result independently carries
  `is_error: true`; successful command output is never promoted to an exit
  code from text alone.

Each provider decides whether non-zero output belongs in `stderr`, `stdout`, or
both according to its harness semantics. The canonical `exitCode` is the fact
the UI uses for return-code display; the stdout/stderr split is the text-channel
fact the UI uses for rendering and copy.

## Planned Phases

1. **Default provider base/equivalent helper.** Add a shared default
   implementation equivalent to the current YA heuristic: strip common command
   envelopes, split output from metadata, parse common exit-code/wall-time
   strings, and fill `stdout`, `stderr`, `exitCode`, `wallTime`,
   `interrupted`, and `backgroundTaskId` when present. Wire it as the default
   for the provider base class or the current equivalent shared provider helper,
   with a TODO at each provider call site to refine against that harness's
   actual raw events.
2. **Provider-specific refinement.** Codex/Codex OSS should use command
   execution `exitCode` and `aggregatedOutput` directly. Claude should preserve
   SDK-provided structured Bash results without re-parsing when fields already
   exist. ACP-style providers should map their tool-call completion fields
   explicitly rather than relying on string envelopes.
3. **Renderer simplification.** Once provider normalization is reliable, move
   client parsing behind a legacy-only compatibility helper and make Bash/Ran UI
   decisions depend on structured facts: has output, exit code, interruption,
   background id, and timing.
4. **Regression fixtures.** Add per-provider replay fixtures for:
   successful output, successful no-output, non-zero no-output, non-zero stderr,
   interrupted, backgrounded, and legacy string-envelope results.

## Non-Goals

- Do not make the client infer provider semantics from display labels such as
  `Ran`.
- Do not require providers to expose facts they genuinely do not have.
- Do not break persisted old transcripts; missing fields keep the current
  fallback behavior.
