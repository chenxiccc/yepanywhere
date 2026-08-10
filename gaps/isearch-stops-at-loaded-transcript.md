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

A broader mitigation worth preferring over search-triggered full-message loads
is a server-owned session digest. Each durable turn or searchable row would
contribute a stable source ID/cursor, a searchable excerpt, and a rough rendered
height or cumulative-height estimate. The client could then search the whole
session and place the current scrollbar/turn-rail UI approximately without
retaining every full message. Selecting a digest match would hydrate a bounded
real-transcript window around its cursor, preserve the search query and
selection, and replace estimated geometry with measured row heights as content
mounts. Height is deliberately approximate metadata, not a layout contract;
the loaded rows remain authoritative.

Before choosing the endpoint shape, compare fetching one compact digest for
client-side search against server-side query results plus a coarse full-session
height index. The former makes repeated Ctrl+R/Ctrl+S responsive but may still
be large for extreme sessions; the latter bounds transfer but adds query
round-trips and needs explicit result ordering/version consistency while the
session grows.

Found 2026-08-10 while extending older-history loading and keyboard turn navigation.
