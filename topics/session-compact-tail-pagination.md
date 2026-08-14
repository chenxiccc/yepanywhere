# Session Compact-Tail Pagination

> `tailCompactions` on the session-detail API names the number of compact
> boundary markers to include at the top of the returned tail window, not the
> number of post-compaction message spans to count.

Topic: session-compact-tail-pagination

## Contract

For `GET /api/projects/:projectId/sessions/:sessionId?tailCompactions=N`,
the returned transcript window should start at the Nth compact boundary from
the end when at least N compact boundaries exist. The boundary message itself
is included so the client has an explicit "Context compacted" divider at the
top of the window.

If fewer than N compact boundaries exist, the endpoint returns the full
transcript. That preserves the intuitive "N compact windows" behavior for
short sessions: with `tailCompactions=2`, a session that has only one compact
boundary has only two windows total, so returning the beginning, the boundary,
and the current tail is acceptable.

For `tailCompactions=2`, the intended shapes are:

| Total compact boundaries | Returned shape |
| ---: | --- |
| 0 | full session |
| 1 | beginning, `C1`, tail |
| 2 | `C1`, middle, `C2`, tail |
| 3 | `C2`, middle, `C3`, tail |
| 100 | `C99`, middle, `C100`, tail |

### Compact scope and turn selectors

An uncursored session-detail read is authorized to inspect only the last two
compaction windows by default. `tailTurns` and `tailFrom` select a smaller
suffix inside that compact scope; they do not authorize reading across its
older boundary. This distinction matters because one provider turn can contain
multiple compactions and thousands of normalized rows, so a turn count is not
itself a safe response-size bound.

The effective start is the later of the compact-boundary start and the
turn-selector start. Consequently, `tailTurns=20` means "up to twenty turns
within the authorized compact scope," not "return twenty turns even if that
crosses older compactions."

`fullHistory=1` is the explicit authorization to remove the default compact
scope. It may be combined with `tailTurns` or `tailFrom` so the server selects
a bounded suffix from the full transcript without sending the full transcript
to the client first. Without `fullHistory=1`, those selectors can only narrow
the default or explicitly requested compact window.

| Query | Effective scope |
| --- | --- |
| no query | last two compaction windows |
| `tailTurns=20` | up to 20 turns within the last two compaction windows |
| `tailFrom=<id>` | from the id only when that is later than the compact start; otherwise clamp to the compact start |
| `tailCompactions=5` | last five compaction windows |
| `fullHistory=1` | full transcript |
| `fullHistory=1&tailTurns=20` | last 20 turns across the full transcript |

`afterMessageId` remains an incremental cursor rather than an initial history
scope. If that cursor cannot be found, the route falls back to the default
two-compaction tail. `beforeMessageId` remains the explicit older-page cursor
and returns another compact-boundary-shaped page.

If an `afterMessageId` request fails at transport, relay, decode, or server
handling rather than returning a response, the mounted client performs one
uncursored request with the same compact-tail bounds inside the existing
per-session in-flight coordinator. A successful response atomically replaces
the loaded tail window. If that reconciliation also fails, the attempt stops;
it creates no timer or internal retry loop. Later external activity may start
another coalesced attempt. Diagnostics are available in development or during
explicit remote-log collection, limited to one report per route per 30
seconds, and state how many failures were suppressed.

## Why This Matters

The previous boundary condition used `totalCompactions <= tailCompactions` as
the full-history case. That made a session with exactly two compact boundaries
return the initial prompt and all pre-compaction history for the default
`tailCompactions=2` request, then abruptly shrink once a third compaction
arrived.

That discontinuity is user-visible on long Codex sessions because provider
JSONL can expand a modest number of user turns into hundreds or thousands of
normalized render rows. A syntactically bounded `tailCompactions=2` request can
still be expensive if the exactly-two-boundary case returns the entire
transcript.

## Older-Page Pagination

`beforeMessageId` uses the same rule on the prefix before the cursor. If that
prefix contains at least N compact boundaries, the older page starts at the
Nth boundary from the end of that prefix and reports `hasOlderMessages: true`.
The next older-page request can then fetch the pre-boundary prefix. This may
require one additional page compared with the former full-prefix behavior, but
it keeps every page shaped like the requested compact tail.

The session transcript treats a visible older-page control as demand to reveal
at least one earlier real user turn, or to reach the beginning of history. One
demand may therefore follow several `truncatedBeforeMessageId` cursors through
assistant, tool, compact-summary, and other synthetic-user-only pages. Each
server response remains bounded to the existing compact-tail page contract;
the client performs the continuation and older servers need no new route,
field, or capability.

The continuation pauses after eight pages or after retaining approximately one
session-detail cache budget of additional transcript data, whichever happens
first. If older history remains and no real user turn was reached, the client
shows that it paused and leaves the button available for an explicit next
batch. This makes arbitrarily deep traversal possible without letting one
scroll gesture monopolize memory or the network.

The control automatically starts one such demand when it enters the transcript
scrollport, while retaining the button as the no-observer and explicit-retry or
continuation fallback. If a request fails without advancing the cursor, leaving
and re-entering the boundary permits one new automatic attempt; a continuously
visible failed cursor does not create a retry loop. Every multi-page prepend is
one scroll-preservation transaction, so the reader's current transcript
position remains stable. After that demand settles, a continuously visible
boundary does not start another demand: it must leave and re-enter the
scrollport, preventing automatic history drainage beyond the user-turn or
safety boundary.

Keyboard navigation at the loaded boundary is explicit demand, independent of
that passive visibility latch. A non-repeated `PageUp` that settles at the top
starts one older-history demand. Previous-turn `Home` starts one demand when no
earlier loaded user turn exists. Key repeat does not start additional demands;
after a batch settles, another distinct key press may request the next bounded
batch. The same prepend anchoring and per-demand user-turn/safety limits apply.
