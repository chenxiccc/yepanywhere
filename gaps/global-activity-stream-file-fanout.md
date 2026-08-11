# Global activity stream forwards every file event to every browser

`createActivitySubscription` subscribes to the complete server `EventBus` and
forwards every event without a server-side predicate. Each connected source
activity stream therefore receives every `file-change` event and leaves
project/session relevance filtering to browser hooks. Work grows with global
file activity multiplied by connected browser tabs even when most tabs do not
need those files.

Async rescans, shared focused watches, and exact cross-route deduplication
reduced the work surrounding this path, but do not change this global fanout.
The recovered and remaining performance boundaries are documented in
[`topics/performance-regression-suite.md` § Watcher work bounding](../topics/performance-regression-suite.md#2026-08-08-watcher-work-bounding).

The repair needs an explicit compatibility design rather than silently
changing the activity stream. Decide which event types and project/session
interests a client can declare, whether interests can change without replacing
the stream, and what exact capability gates the request fields. A new client
connected to an older server must retain the unfiltered stream and make no
unsupported request; a new server must preserve broad delivery for older
clients. Measure server serialization and bytes per subscriber before and
after, while proving that sidebar, project, review, process, and reload updates
are not lost.

Found 2026-08-08 during the performance-regression survey and revalidated
2026-08-11 in `packages/server/src/subscriptions.ts`.
