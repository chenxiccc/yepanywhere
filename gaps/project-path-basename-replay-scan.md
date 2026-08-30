# Basename alias replay adds a second transcript text scan

`applyRecentProjectPathLinks()` uses a simple basename map and tokenizes loaded
text bodies after the first confirmed full-path link. This is the smallest
implementation over the client's existing per-body annotations, but it adds a
linear scan to transcript projection. Assistant HTML is parsed only when it
advertises a project-file anchor.

Measure incremental projection time on long loaded transcripts with no links,
one early link, and many colliding basenames before replacing the mechanism. If
the cost is material, build a versioned link-position index or client-local
trie whose row lookup is prefix-causal. The replacement must preserve stable
earlier targets when later rows arrive and must not require a project path
corpus from the server. Do not assume the extra data structure is faster until
the end-to-end replay and render costs show it.

Found 2026-08-30 while choosing the simple basename map for recent project-path
aliases.
