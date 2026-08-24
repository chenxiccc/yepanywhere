# All-Session Content Search

> All-session transcript-content search is not implemented: YA currently
> searches session catalog metadata and searches text only inside session
> detail already loaded by an in-session viewer.

Topic: all-session-content-search

Status: current absence and search boundary. The dormant server-index and UI
design is preserved in
[`all-session-content-search.sketches.md`](all-session-content-search.sketches.md).

## Current contract

YA has no cross-session transcript-content index, content-search route,
capability advertisement, tail-scanning job, or All Sessions result surface
for matching arbitrary turn text. An empty catalog search result therefore
does not make a claim about transcript contents.

All Sessions filtering operates on catalog metadata. In-session search helpers
such as `getUserTurnSearchAnchors` operate over detail data already loaded for
one session. They are interaction precedent only; neither is a global content
corpus, a durable coverage watermark, or a server-side substring index.

Browsing, catalog observation, and existing search must remain app-data-only:
they do not create search state inside a selected project or its Git metadata.
Provider transcripts remain the canonical source, and existing authentication
and session-access boundaries govern who may open them.

## Boundary for future work

A future global-content search is an optional new client/server contract. It
requires the normal stable-release capability review before a new client calls
new routes. Until approved, the client must not infer support or begin
background transcript walks.

The candidate product surface, visible-text corpus, substring normalization,
index structures, asynchronous coverage protocol, privacy rules, and
measurement gates live only in the sketches companion. They are not an
approved schema or performance commitment. A smaller agent-facing bounded
scan route is proposed in
[`agent-session-access.md`](agent-session-access.md); it inherits this same
boundary, corpus rules, and capability review.

Related current contracts:
[session-catalog-observation](session-catalog-observation.md),
[session-detail-data-layer](session-detail-data-layer.md),
[project-directory-storage](project-directory-storage.md), and
[server-performance-observability](server-performance-observability.md).
