# Transcript search stops at the client-loaded history boundary

Ctrl+R, Ctrl+S, and Ctrl+Alt+S derive their candidates from the current
`displayRenderItems` / `turnGroups` in
`packages/client/src/hooks/useMessageListIsearch.tsx`. They therefore cannot
find matches before the client's loaded transcript boundary, even when session
pagination reports more durable history.

This was not fixed alongside older-page loading and turn navigation because
search needs its own continuation contract: it must preserve the query,
selection direction, and scroll-restoration semantics while fetching until a
match, the beginning of history, or an explicit safety boundary. A likely fix
is to let an exhausted reverse search request older user-turn-bounded pages,
then rerun the existing projection without closing the search panel.

The broader digest/index and geometry options now live under
[`topics/transcript-virtualization.md` § Whole-session search across a bounded window](../topics/transcript-virtualization.md#open-architecture-whole-session-search-across-a-bounded-window).
The separate cross-session substring-search proposal is
[`topics/all-session-content-search.md`](../topics/all-session-content-search.md).
Neither architecture proposal blocks the bounded search-triggered pagination
repair described here.

Found 2026-08-10 while extending older-history loading and keyboard turn navigation.
