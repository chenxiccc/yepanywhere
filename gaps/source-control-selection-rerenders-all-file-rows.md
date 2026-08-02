# Source Control: selecting a file re-renders every changed-file row

Selecting a row in Changes sets `selectedPath` in `WorkingTreeBrowser`, which
re-renders the whole `filteredFiles.map(...)` list. The rows are not memoized
and each render rebuilds its context-menu actions, so the cost scales with the
corpus rather than with the two rows whose selected state actually changed.
The list is also unwindowed: every row is in the DOM.

Measured 2026-08-02 against a working tree with ~2100 changed-file rows
(`/local/graehl/trtllm-speculative/draft`), driving the real UI at 1920×1080:

| rendered rows | click → diff request issued |
|---|---|
| ~2100 | 333–393 ms |
| 2 (pane filter applied) | 22–40 ms |

The same re-render happens again when the diff result arrives. Server time for
these selections was 22–55 ms, so at large corpus sizes the client render, not
the diff, is the dominant term.

Not the reported defect (an ordinary working tree has tens of rows, where this
is tens of milliseconds), and out of scope for the diff-latency work that
surfaced it. Fixing it means memoizing the row — which needs the per-row
`menuActions` array and `fileMenu.targetProps` handlers to stop being rebuilt
per render — or windowing the list, which
[`topics/source-control.md`](../topics/source-control.md) § *Search and
compatibility* already permits so long as the window never becomes a
search-coverage limit.
