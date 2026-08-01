# Mixed-Model CSS Module Paydown

Topic: css-architecture

Status: active 2026-08-01.

This is the durable recovery ledger for the explicitly authorized mixed-model
CSS paydown campaign. Candidate selection remains data-driven; this file must
not accumulate a speculative priority queue.

The binding CSS rules are in
[`topics/css-architecture.md`](../../topics/css-architecture.md). Worker routing,
supervision, audit, and stop rules are in the
[`bounded agent process runbook`](../testing/claude-agent-process-runbook.md).

## Authorized bounds

- Start only after the routing protocol update is committed and pushed.
- Launch at most 50 fresh workers; stopped workers count.
- Stop four hours after the first worker launch.
- Stop earlier on provider credit exhaustion or any runbook safety condition.
- Use one worker at a time in the shared checkout.
- Treat five accepted slices as an audit, ledger-update, and push interval.
- Use one-minute authoritative status checks. Apply the additional bounded Luna
  calibration sample described by the runbook until Luna earns alert-only
  supervision.

## Recovery procedure

After compaction or controller restart:

1. Re-read this ledger, the process runbook, and the CSS architecture topic.
2. Check the active goal and reconcile its run/time counters with this ledger.
3. Verify the working tree, `HEAD`, `origin/main`, and any live YA worker before
   launching anything.
4. If a worker is live, resume monitoring its YA session id; never duplicate
   its prompt.
5. If no worker is live, audit any unrecorded commit, regenerate inventory, and
   select one fresh candidate from current data.

## Campaign checkpoint

- Protocol base: `ef2c98ae9b1882d47fc931971881b2f90fba7f08`
- First worker launch: `2026-08-01T07:46:39+02:00`
- Wall-clock deadline: `2026-08-01T11:46:39+02:00`
- Workers launched: 7 / 50
- Accepted slices: 6
- Stopped slices: 1
- Current interval: 1 / 5 accepted after the first audit
- Current worker: none
- Current clean base: this Luna-promotion ledger checkpoint (`HEAD`)

## Completed slices

| Run | Surface | Route | Result | Commit | Ratchet | Supervision evidence |
|---:|---|---|---|---|---|---|
| 1 | Thinking indicator | Luna xhigh: shared keyframe boundary | Stopped before edits: phone fixture absent | — | 0 | Main-browser steer; desktop baseline passed; phone failed one retry |
| 2 | Global tooltip portal | Opus high: local literal move | Accepted | `e5fb8e5b` | 33 legacy lines, 2 owned rules | Alert-only monitoring; controller-proven fixture; no steer |
| 3 | Thinking indicator | Luna xhigh: shared keyframe boundary | Accepted | `2134543c` | 60 legacy lines, 6 owned rules | One calibration sample; isolated fixture; no steer |
| 4 | Viewer-count indicator | Opus high: local literal move | Accepted | `ff95c92b` | 42 legacy lines, 5 owned rules | Alert-only monitoring; exact two-viewport captures |
| 5 | Risk affordance | Opus high: local state move | Accepted | `11da906e` | 56 legacy lines, 6 owned rules | Alert-only monitoring; delayed tooltip fixture; no steer |
| 6 | Smart Turn controls | Luna xhigh: scattered finite state mapping | Accepted | `68f3adea` | 112 legacy lines, 15 owned rules | One calibration sample; four exact captures; no steer |
| 7 | Remote compatibility notice | Luna xhigh: finite placement, severity, and child state | Accepted | `e272731d` | 176 legacy lines, 24 owned rules | Final calibration sample; four exact captures; no steer |

The common project id for these workers is
`L1VzZXJzL2tncmFlaGwvY29kZS95ZXBhbnl3aGVyZQ`. Exact recovery handles and
prompt digests are retained here even though the prompt and capture packets are
ignored local artifacts:

| Run | YA session | Process | Base | Prompt SHA-256 |
|---:|---|---|---|---|
| 1 | `019fbbdc-38c4-7752-9912-705077d09996` | `b0939f42-bbfd-4168-a925-37ef3ef5a7ff` | `aba659c8` | `f60d5c4c167169bc45594159d0da7e1a5a75cfffbb8f09350740314354ab959b` |
| 2 | `4978ed76-6877-4183-b798-9e5bffffc8ac` | `efdfb676-d3b6-4cea-b17d-14110c9e88a0` | `511a3fa5` | `b68c109b5c53d748d62dbbbb0cc63652c154760cd8fc51fe17da21a229152a87` |
| 3 | `019fbbf5-5d2c-7241-bbb9-2510b0189795` | `424f6225-b6d4-4ca5-be44-838046ac5ab9` | `0896e917` | `49f2c1f7ec9648a1e5d3db4502e81fe8b39094141b1ca8eb35bf95d5d51f414b` |
| 4 | `e6447823-8475-4bd9-9396-cd2aa4cdcb7f` | `5ebb1096-edd9-4ae7-95c9-cdcf6c851171` | `2134543c` | `a08d80682631f0f40e3ad6ab285cfc10d9489a526557eb6068c5a8d9a4b7b4f9` |
| 5 | `2ab5c2d1-6bc8-463e-a6de-461757d6f2f1` | `24ebd7dc-6314-489f-821f-2fd9de4902eb` | `ff95c92b` | `ecc172bd7b9a4b55b2208e831bdf08334d80b22c3757ff051dda415854433b69` |
| 6 | `019fbc1e-0159-74b2-b810-3586d1b7d13a` | `5079622a-35e5-4463-8269-d7097641f558` | `f621bd4b` | `165100bd77c56042b8b72a5f5a503485508c7c5607858d5ed89a84612efeec25` |
| 7 | `019fbc31-792d-7b83-98f8-652a2e305171` | `8334f7d4-1329-49de-9eee-14b0a847ff05` | `dfaf3cc9` | `b05d000806d48abbb7417a7efc91c8a03cd247d84f1946aecf97759ebe289c9d` |

## Audit interval notes

Run 1 validated the stop path but exposed a
harness-routing error: the worker initially opened the maintainer's main browser
and encountered its localhost certificate warning. The runbook now directs
local campaign fixtures straight to repository headless Playwright. The supplied
Agents-page fixture was present at desktop width but absent at phone width, so
the candidate was left unmigrated until the isolated component fixture made
run 3 deterministic.

Run 2 completed without attention or scope events. Opus preserved the portal
and stacking contracts, passed the full check matrix, and produced a
byte-identical phone target. A one-row desktop element-crop difference was
localized to fractional screenshot rounding; computed layout and the rendered
surface were unchanged.

The next tooling checkpoint added
`packages/client/e2e/css-component-fixture.html`, a test-only Vite page that can
render deterministic component exports from JSON props at real browser widths.
This avoids spending provider sessions manufacturing rare application state.
It remains unsuitable for caller-layout, portal, generated-markup, or other
integration boundaries.

The first accepted interval is runs 2-6. It moved 303 legacy lines and 34 owned
rules into five new modules: legacy lines fell from 24,107 to 23,804 and owned
rules from 2,183 to 2,149. Coupled rules remained 832, generated rules 50, and
unresolved selectors 78. Every slice passed the focused and full client tests,
CSS ratchets, unused-CSS scan, lint, typecheck, console scan, and diff check.
The component fixture produced exact desktop and phone target pixels for runs
3-6; run 2's only visual delta was the already-audited one-row fractional crop.

Opus completed all three mechanically routed slices without a steer or audit
surprise. Luna completed both post-steer slices without a correction; the next
Luna slice remains in calibration for one bounded scope sample, and a third
consecutive clean Luna result will earn alert-only supervision. The model
routing criteria remain unchanged: Opus is the economical default for a proven
literal packet, while Luna is useful for finite state mapping and diagnosis.

The interval also confirmed that inventory `testFiles` are selector-vocabulary
contracts rather than all direct component tests. The runbook now requires one
bounded component-test search after owner drill-down; no analyzer repair was
needed. A clean disjoint cross-host documentation commit landed between runs 5
and 6, was attributed before launch, and did not overlap the CSS slice. The
worker's historical launch base `f621bd4b` and result `7e4faadf` became
`91509484` and `68f3adea` in the clean checkpoint rebase onto remote main; the
recovery table intentionally retains the exact launch-time base and prompt
digest.

Run 7 opens the second interval with another finite-state Luna slice. It moved
176 legacy lines and 24 owned rules with all friction counts unchanged, passed
the full check matrix, and produced exact pixels for floating-security and
inline-info cards at both viewports. This is Luna's third consecutive clean
post-steer result, so subsequent Luna slices now use the same one-minute,
alert-only supervision as Opus. Any later trust-gate event, scope steer,
unexplained verification failure, or out-of-order commit resets calibration as
specified by the runbook.

At each five-slice checkpoint, append aggregate inventory movement, model
outcomes, fixture/check evidence, steering events, routing changes, and the
pushed base.
