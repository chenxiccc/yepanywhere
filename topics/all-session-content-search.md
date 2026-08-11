# All-session content search

> All-session content search is a proposed server-owned substring search over
> transcript turns across every session or one project, returning indexed
> results immediately and asynchronously scanning uncovered tails while
> reporting its coverage.

Topic: all-session-content-search

Status: **proposal only**. No index, route, capability, or client surface is
approved for implementation.

Related topics: [session-catalog-observation](session-catalog-observation.md),
[session-detail-data-layer](session-detail-data-layer.md),
[composer-recall-drawer](composer-recall-drawer.md),
[project-directory-storage](project-directory-storage.md), and
[server-performance-observability](server-performance-observability.md).

## Product surface

The same search facility serves:

- **All Sessions** across every known project;
- **All Sessions in this project** with the project fixed as a query scope; and
- later direct links from another surface that wants the same corpus.

Matching is case-normalized arbitrary substring matching anywhere within turn
text, not initial-prefix matching and not semantic search. The motivating use
case is recollection: “I remember asking about this thing; isearch may be good
enough.” No embedding, model call, paraphrase retrieval, or fuzzy semantic
ranking belongs in the first contract. Results identify project, session,
provider, timestamp, turn role, a bounded highlighted excerpt, and a stable
deep link to the matched turn. Existing All Sessions metadata filters remain
composable with content search.

The role selector is **User / Assistant / Both**:

- **User** indexes text the user actually submitted, before any YA/provider
  context injection.
- **Assistant** indexes visible assistant-authored response text.
- **Both** searches the union.

Exclude synthetic or automatically inserted turns, hidden
system/developer/project context, reasoning/thinking, tool calls/results,
activity/status rows, and provider-bound text YA adds without showing in the
conversation. The index corpus is the stable visible conversation, not every
record in a provider transcript.

### Display-normalized substring matching

Matching may cross harmless presentation differences within one logical source
line without becoming fuzzy:

- compare case-normalized text;
- fold horizontal whitespace runs to one logical space; and
- ignore Markdown emphasis delimiters where they only decorate otherwise
  adjacent visible text.

Keep a mapping from normalized offsets back to visible source spans so excerpts
and highlights remain exact. A newline or paragraph boundary ends the searchable
segment: the query does not synthesize a phrase across separately authored
lines, regardless of responsive visual wrapping. Inline structures such as
Markdown links and code may also remain hard segment boundaries. Matching text
wholly inside a link label is allowed, but a phrase that begins outside the link
and ends inside it (or the reverse) is not required. Exact verification applies
these same normalization and boundary rules after the index proposes a
candidate.

## Indexed prefix plus asynchronous completion

One query can combine two evidence sources:

1. A durable combined index covers transcript items through explicit
   per-source and per-session watermarks. It returns the fast initial result.
2. A slower targeted scan reads uncovered project/session tails, streams new
   matches into the result, and advances coverage for future queries.

The client must show whether results are complete, index-backed but partial, or
still scanning. A fast empty indexed result is not “no matches” while uncovered
tails remain. A new query cancels or supersedes the old scan; late results carry
the query id and coverage generation so they cannot contaminate the newer
result.

Coverage is structural, not merely a wall-clock cutoff. Provider stores differ,
so a watermark may be a durable message id, file identity plus byte offset,
source generation, or another adapter-owned append boundary. Rewrites,
truncation, compaction, session-id remap, and provider-file replacement must
invalidate the affected shard instead of certifying stale text.

## Index shape

The contract is an all-substrings index; the data structure is deliberately
open. A plain trie indexes prefixes and is not sufficient. Inserting every
suffix into a trie would create unacceptable amplification on long transcripts.
Likely candidates include a normalized trigram inverted index, a suffix
automaton/tree with measured storage behavior, or a hybrid whose postings
identify candidate turns and whose final comparison verifies the exact
substring.

Partition the durable index into bounded project/provider shards so one cold
project can be rebuilt or evicted without loading the global corpus into RAM.
Global search merges shard postings; project search touches only that project's
shards. Hot dictionary/posting metadata may be retained under a byte budget,
while turn text and cold postings remain disk-backed.

The index lives in YA app data. Merely enabling or using search must not write
inside projects or their Git metadata. It is rebuildable derived state, not the
canonical transcript.

## Incremental maintenance

The session catalog supplies identities, project mapping, provider families,
and freshness signals; it does not become a full transcript store. Provider
adapters extract searchable turn records at their existing parse boundary and
publish append/rewrite deltas to the search index. The future canonical session
detail layer should expose the same normalized visible-turn text so live,
persisted, replayed, and provider-specific paths do not index different
projections.

Maintenance priorities:

1. append or replace turns for live sessions;
2. finish tails requested by an active search;
3. reconcile changed known sessions in bounded background batches; and
4. rebuild cold or invalidated shards only under explicit interest or spare
   bounded capacity.

No keystroke may trigger a synchronous walk of every transcript. Repeated tabs
and clients asking the same query/coverage generation should share one in-flight
search and one tail-completion job.

## Responsive query contract

- Typing updates the field immediately and issues cancelable/debounced queries.
- Indexed matches arrive first with a stable deterministic order.
- Tail-scan matches merge without resetting selection, scroll position, or
  already-rendered rows.
- Progress names concrete remaining coverage, such as projects/sessions still
  scanning, rather than a decorative spinner.
- Pagination applies to ranked matches while coverage state describes the whole
  query, not only the current page.
- Exact substring verification prevents trigram/normalization candidates from
  becoming false-positive UI matches.

The existing in-session isearch and `getUserTurnSearchAnchors` are interaction
precedent, not the global data source: they operate over already-loaded session
detail, while this proposal must answer without mounting or loading every
session in the browser.

## Compatibility, privacy, and measurement gates

A new permanent server capability must gate content-search routes and result
semantics. Older servers retain the current All Sessions title/metadata search
and receive no unsupported requests. The compatibility corpus and exact
fallback require the normal client/server review before implementation.

Search remains authenticated and source-scoped. Result excerpts must follow the
same access boundary as opening the session itself. Index files inherit app-data
permissions and must not include hidden provider context until a separate
privacy/product decision defines that corpus.

Before choosing an index or enabling background maintenance, measure realistic
small and large installations:

- cold build and incremental append cost;
- disk amplification relative to searchable text;
- retained RAM and shard-eviction behavior;
- indexed-query p50/p95 latency by query length and result count;
- slow-tail completion latency and cancellation waste; and
- exact-result parity against a full reference scan.

The performance suite should exercise user-only, assistant-only, and combined
scopes, including within-line whitespace/emphasis normalization, newline and
paragraph stops, and hard inline-boundary cases.
