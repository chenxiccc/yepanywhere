# Recent path links do not resolve longer matching suffixes

`applyRecentProjectPathLinks()` retains only a linked full path's basename. If
`packages/server/src/routes/sessions.ts` was linked, a later `sessions.ts` can
resolve from that context, but `routes/sessions.ts` and
`src/routes/sessions.ts` cannot.

A reasonable extension is to retain every proper path suffix and resolve each
later suffix from the most recently preceding confirmed full-path link. It must
remain prefix-causal and must not refresh the table from a suffix-expanded
link. Before accepting the extension, measure projection time and retained
entries on long transcripts and deep project paths: indexing every suffix
changes one table entry per mention into work and memory proportional to path
depth. Use those measurements to choose a bound rather than assuming the cost
is harmless.

Found 2026-08-30 while scoping recent project-path aliases to basenames.
