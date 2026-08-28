# Semantic UI actions

> Typed YA client operations captured after raw browser input is interpreted
> and before existing domain effects, so a harness can gather or replay them
> against server-message anchors without adding a view-layer event stream.

Topic: semantic-ui-actions

## Contract

Semantic UI actions are an opt-in performance-harness seam, not a second
client state system or a user-facing automation feature. The first vocabulary
contains one versioned `composer.submit` action with `send` and `defer`
operations. Human composer handlers and replay both invoke the same executor
owned by `SessionPage`; replay does not synthesize keyboard, pointer, or DOM
input events.

`executeSemanticUiComposerAction` owns the inactive gate. With no installed
harness it performs one enabled check and directly calls the supplied
executor. It must not construct or clone a record, read a clock, traverse a
listener collection, schedule work, or retain data on that path.

An enabled gatherer records:

- schema and action identity;
- source and YA-visible session identity;
- composer operation, text, and submission metadata; and
- the most recent message event that `useSessionStream` observed, plus the
  relative delay from observing it to invoking the composer executor.

An anchor contains the subscription event ID and, when available, the durable
message ID. A durable message ID is authoritative: replay must match it and
must not fall back to a reused event ID after reconnect. Event ID matching is
allowed only for records without a durable message ID. Observed message types,
delta types, identities, and monotonic times are retained only while the
harness is enabled so an external runner can align server-stream and visible
browser measurements across reconnects.

Replay validates the record, waits for the anchor, applies any remaining
recorded relative delay, and invokes the registered composer executor. Anchor
timeout, an invalid record, a missing executor, or an executor failure returns
an explicit divergence. The harness retains all measurements and the first
divergence. A browser runner may record a `screen-condition` divergence when
its ordinary rendered-state predicate fails; rendered state is not copied into
the semantic action stream.

The harness is installed only when a runner places this bootstrap on `window`
before the client bundle loads:

```js
window.__YA_SEMANTIC_UI_ACTIONS__ = {
  schemaVersion: 1,
  gather: true,
  replay: true,
};
```

The client replaces the bootstrap with the versioned gather/replay API. YA
does not persist action records or expose a production control for this mode.

## Performance-suite coverage

The `specialized-contracts` driver starts a fresh isolated server, simulated
provider runtime, and Playwright browser. It establishes a real session-stream
message anchor, performs one human Send, replays the gathered record directly,
and waits for provider completion plus a mutation-time visible result. It
records client action phases, message-accept round trip, first server-stream
text delta, and visible completion.

The same leg deliberately replays an unmatched durable message ID and requires
an anchor divergence without losing prior measurements. It also checks that
the initial, anchor, human, and replay assistant rows retain their content and
document order. The simulated provider therefore preserves the resumed durable
session ID and gives each worker runtime unique assistant-message IDs.

Each dev-wrapper leg receives a short isolated provider-host runtime directory,
suppresses first-run onboarding through the established test switch, and
deletes the runtime directory during normal or failed teardown. The suite's
marker sweeps remain the authority for process-survivor checks.

## Acceptance evidence

On 2026-08-28 this command completed three repetitions on eligible capacity
key `host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835`:

```bash
node scripts/perf-suite/run.mjs \
  --checkout /local/graehl/yepanywhere \
  --fixture-repository /local/graehl/yepanywhere \
  --scenario specialized-contracts \
  --driver specialized \
  --label semantic-ui-action-stream-final
```

Every repetition gathered and replayed the action, observed both visible
outcomes, preserved prior turns, recorded the deliberate anchor divergence,
retained nine client/server measurements, emitted no browser diagnostics, and
passed every survivor check. The aggregate medians were 591.9 ms from human
action to visible result, 132.9 ms for replay execution, 187.0 ms from replay
to visible result, 30.498 ms for message acceptance, and 117.0 ms to the first
text delta observed from the server stream. These deterministic fixture
timings validate the measurement path; they are not production latency targets.

The disabled-path microbenchmark used seven alternating samples of 200,000
calls in each repetition. Median added cost was 1.0, 0.5, and 1.5 ns per call;
the largest observed paired upper bound was 4.5 ns per call. Unit tests also
prove that the disabled path calls no clock or payload-cloning function.

The local raw result is
`scripts/perf-suite/results/semantic-ui-action-stream-final-specialized-specialized-contracts-55c86c77.json`.
It records harness content hash
`1133dbe1cea5b1189849589da1715b7e3606ce0cca865d0754379bddb7fa916b`;
raw performance results remain gitignored by the suite contract.

## Current boundary

The implemented vocabulary is intentionally composer-only. Navigation and
transcript-scroll actions should be added only when a representative trace
requires them. There is no canonical-message digest fallback yet because the
first fixture supplies durable message IDs; a future record lacking both a
durable ID and a replay-stable event ID must diverge rather than substitute an
unanchored delay.

First-text-delta time ends when the browser observes the server event. It does
not decompose provider worker, Hono, fan-out, WebSocket, and client
reconciliation phases; the bounded system-observed performance sprint may add
those clocks when its active theory needs them.
