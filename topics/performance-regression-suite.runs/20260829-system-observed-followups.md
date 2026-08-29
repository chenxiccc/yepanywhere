# 2026-08-29 System-Observed Performance Follow-ups

Status: complete. The ordered follow-up sprint bounded the loaded transcript's
live DOM, reduced older-history prepend stalls, confirmed that persisted
augmentation already reuses unchanged messages, and showed that tooltip delay
was transcript amplification rather than a tooltip-owned defect. Both opened
performance gaps can close without a speculative augmentation or tooltip
rewrite.

## Result at a glance

| Follow-up | Disposition |
|---|---|
| Yield older-page prepend | Accepted at eight semantic-weight units per animation frame. The final trace completed without a multi-second task or control timeout; its longest prepend-associated tasks were 118–127 ms. |
| Instrument persisted augmentation | Instrumentation accepted; optimization stopped at its evidence gate. Every settled control repetition reported 720 hits, 361 work starts, zero joins or failures, and 361 retained entries. |
| Bound mounted transcript rows | Accepted. The final 360-turn state fell from 722 mounted rows and 18,985 elements to eight rows and 435 elements while retaining all loaded rows in the semantic model. |
| Re-check tooltip reveal | No tooltip edit. Reveal work after the configured 80 ms delay fell from 414–548 ms with 186–299 ms of long tasks to 146–147 ms with no long task. |

The implementation commits are `c060e8fe` (yielded prepend), `0a94f914`
(augmentation evidence), `11c0a971` (semantic render window), and `b1e0d4a4`
(eight-unit prepend batches).

## Comparison identity and integrity

The principal comparison used the same `sprint-long-360` browser scenario,
three repetitions, 360 initial turns plus one append, 1000×600 viewport,
Conversation View settings, disabled active-window trimming, and full
interaction trace. Both outputs used
`system-observed-sprint-20260828-config.json` (SHA-256
`38cf02658e1518ce71d3e5aca97d1b4dc1df38e0f70279beea344bfbf17a8421`).

| Condition | Source revision | Result artifact | SHA-256 |
|---|---|---|---|
| Unwindowed, yielded prepend | `0a94f9149ee067fc29179e5d8ba4d09e1db005bf` | `perf-followups-20260829-browser-360.json` | `c0e2ad83bfbecc58fb482ca1a5b0686a333d5e9082b0d6d1ba5560c163d96cb5` |
| Windowed, eight-unit prepend | `81e9a4e75cb7bfb0c93a83b76c9cb90cb5b3804d` | `perf-followups-20260829-browser-360-windowed-batch8.json` | `aa5e73b0d44ae90a212e5c02e1c4dfb58291f4cceec095d0f45cce28dac8bce6` |

The accepted run is job
`perf-followups-browser-window-batch8-360-20260829`, run
`20260829T065743Z`, aim hash `b4be178627949ce6eb6f139c`, with its run record
under `runs/aim/perf-followups-browser-window-batch8-360-20260829/runs/`.
The final implementation tip `b1e0d4a4` has the same complete tree as the
recorded source revision; the intervening change is only commit-history
finalization.

All three accepted repetitions passed the fixture's project/session, 720
initial-message, 722 appended-message, glossary, path, and Claude-family
correctness needles. The host was ratchet-grade under capacity key
`host-v1-linux-x64-16cpu-126720mib-ecfa1407f7322835`: 16 effective CPUs,
0.143 baseline CPU-busy fraction, 0.301 maximum load per CPU, at least
110,064,590,848 bytes available memory during the run, and no swap growth.
Each repetition and the final marker-family sweep were clean; the run log had
no warning, error, timeout, retry, fallback, failure, signal, stale, invalid,
or survivor anomaly.

## Browser result

Ranges below are the three repetitions rather than pooled values.

| Measurement | Unwindowed | Windowed, eight-unit prepend |
|---|---:|---:|
| Final mounted render rows | 722 | 8 |
| Final DOM elements | 18,985 | 435 |
| Final Chrome DevTools Protocol nodes | 46,506–46,509 | 931–933 |
| Final layout objects | 26,498–26,501 | 451–454 |
| Conversation scroll frame p95 | 200.1–233.3 ms | 66.7 ms |
| Conversation scroll frame maximum | 266.7–500.1 ms | 133.3 ms |
| Conversation scroll long-task total | 5,503–6,173 ms | 542–812 ms |
| Conversation scroll longest task | 195–437 ms | 118–127 ms |
| Conversation typing key-to-frame p95 | 18.3–19.4 ms | 19.1–19.6 ms |
| Conversation typing key-to-frame maximum | 30.6–53.6 ms | 32.1–43.1 ms |
| Full-projection typing maximum | 239.5–244.3 ms | 18.8–21.2 ms |
| Projection next paint | 286.9–303.9 ms | 71.2–105.5 ms |
| Tooltip work after 80 ms delay | 414.0–548.1 ms | 146.0–146.7 ms |

The Conversation scroll reaches the top and automatically loads older history
before the trace's later explicit older-history action. That is why the
explicit action is null and the scroll contains the prepend work. The measured
draft typing precedes that scroll; it is not concurrent-prepend typing
evidence. The final prepend-associated tasks remain slightly above the
approximately-100-ms target, but the original 1.27-second task and two
10-second control timeouts are gone. A four-unit batch probe reached 105–117 ms
tasks but delayed the next tooltip action by about 24 seconds, so it was
rejected.

The full projection improved sharply, with no typing or projection long task,
but its scroll frame p95 rose from 16.8 to 33.4 ms and its missed-frame
fraction from 0–0.004 to 0.227–0.290. Maximum frames remained 33.4–50.1 ms and
there were no full-scroll long tasks. This is an accepted measured-height
windowing trade-off, not a clean win on every frame statistic.

The full-mode scroll restored its starting edge in all repetitions. The
Conversation scroll did not report exact numeric edge restoration because
height correction changed the modeled total geometry while loading history;
row-anchor preservation remains covered by the focused unit contract. Search,
recall, route restoration, keyboard and turn-rail navigation, distant quote
anchors, disclosure state, short-session identity, and bottom-follow behavior
are likewise covered by focused client tests rather than by this one browser
trace.

The unwindowed hover-card baseline was already visible at the sampling boundary
and reported zero work, so it is not comparable. The accepted condition showed
the provider badge after 306.5–306.8 ms of work beyond its configured 240 ms
delay and no long task.

## Persisted augmentation probe

The control and tracked 50 ms delay conditions used source `0a94f914`, three
ratchet-grade repetitions, and clean repetition/final sweeps.

| Augmentation clock | Control | +50 ms probe | Delta |
|---|---:|---:|---:|
| Warm detail p95 | 86.3 ms | 131.1 ms | +44.8 ms |
| Appended detail p95 | 95.5 ms | 144.8 ms | +49.3 ms |
| Cold detail p95 | 532.5 ms | 610.1 ms | +77.6 ms |

The control artifact is
`perf-followups-20260829-augment-control.json` (SHA-256
`b4b25d1b9b6fd5b092237121d5b59ee951f3a026a3064920c911518634ac7b24`);
the delay artifact is `perf-followups-20260829-augment-delay-50ms.json`
(SHA-256
`c60b65cafb439634d811347164ec08635db8d8b2a96daa124f91cd4f4deb7d4c`).
The near-50-ms warm and appended shifts confirm that the augmentation clock is
on the endpoint path. Every settled control repetition reported `cacheHits=720`,
`workStarts=361`, `joinedCalls=0`, `failures=0`, `retainedEntries=361`, and
`inFlight=0`, with no evictions or stale/unretained completion. Unchanged
messages therefore hit the existing source-versioned cache rather than being
re-augmented; adding delta-route reuse would duplicate the current invariant
without an observed owner.

## Acceptance and closure

The browser trace establishes bounded live DOM/layout structure, removes the
multi-second prepend/control failure, and removes tooltip long-task
amplification. The focused client contract establishes the wake, identity,
anchor, navigation, disclosure, and follow behavior that cannot all be
exercised in one deterministic interaction trace. No separate screenshot pass
was used because this change has no intended visual-layout result; the system
trace and behavioral tests are the acceptance surfaces.

The approximate heavy-redraw target is met closely rather than strictly: the
accepted prepend's longest individual tasks are 118–127 ms. The rejected
four-unit control shows that smaller batches can move work into much worse
follow-on latency. With that limitation and the full-scroll trade-off recorded,
the `perf-sprint-system-observed-followups` and
`full-transcript-render-window-virtualization` gaps are complete.
