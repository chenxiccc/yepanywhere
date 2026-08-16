# Codex Sessions

> Codex sessions are provider-owned rollout files that YA reads as durable
> transcript state, grouped by `session_meta.cwd` rather than by directory
> layout; YA must preserve that provider storage model without turning rollout
> discovery into unbounded repeated work.

Topic: codex-sessions

Related topics: [codex-metadata-scanner](codex-metadata-scanner.md),
[provider-refresh](provider-refresh.md),
[session-context-actions](session-context-actions.md),
[session-ownership](session-ownership.md),
[architecture-mandates](architecture-mandates.md).

## Storage Shape

The active Codex provider path is the installed Codex CLI/app-server. Codex
owns local durable history under the Codex home directory, normally:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
```

Each rollout is append-oriented JSONL. The first record is expected to be
`session_meta`, carrying the session id, cwd, timestamp, and related provider
metadata. YA uses that head metadata to answer questions Codex's directory
layout does not answer by itself:

- which project/worktree a rollout belongs to;
- which rollout id should be listed and opened;
- how to seed a session summary before reading the whole transcript.

This differs from Claude. Claude's local session path already encodes the
project directory, so project discovery can start from directory names. Codex
stores by date, so project discovery requires metadata.

One deliberate exception to "YA never rewrites provider-owned rollouts": when
the user explicitly Kills a Codex session, YA renames its rollout with a
`.killed-<timestamp>` suffix so no resume path (YA or Codex app-server) can
find it. The rename is reversible and the content untouched; see
`topics/heartbeat.md` § Unowned Resume Exemptions and
`packages/server/src/sessions/resume-exemption.ts`.

## Process-Scoped Subagent Depth

The server-wide **Subagent nesting limit** is snapshotted for each newly started
or resumed Codex provider process. Numeric values `0` through `4` are sent as
`agents.max_depth` in the app-server config for `thread/start`, `thread/resume`,
and `thread/fork`; **Provider default** stores `null` and omits that key. YA
defaults the setting to `1` and never writes `~/.codex/config.toml`.

Pinned Codex core source describes `agents.max_depth` as a V1 multi-agent-thread
limit and explicitly says V2 ignores it. The Providers caption must retain that
limitation; YA must not imply that the setting constrains Codex V2 or Codex OSS
without a separately verified control.

## Read Surfaces

There are two main YA surfaces over the same rollout tree:

- `packages/server/src/projects/codex-scanner.ts` discovers Codex projects by
  recursively finding rollout files, reading first-line `session_meta`, and
  grouping by canonical cwd.
- `packages/server/src/sessions/codex-reader.ts` lists and loads Codex sessions
  for a project. Listing also needs rollout metadata; loading a session reads
  the full JSONL and normalizes entries for rendering.

`ProjectScanner` and route-level provider catalogs try to share this work
within a request path, while `SessionIndexService` persists provider-neutral
session summaries. `SessionDiscoveryIndex` now persists normalized provider
head metadata for observed rollout files under
`{dataDir}/indexes/session-discovery/`, including optional source fingerprints
for replacement detection. These layers reduce duplicate reads, but only
provider-owned files are authoritative.

## Compression And Representation

Upstream Codex can compress cold rollout files from:

```text
rollout-....jsonl
```

to:

```text
rollout-....jsonl.zst
```

The Codex Rust source treats this as a representation change, not a deletion:
compressed files are read through a line reader, and a compressed rollout can
be materialized back to plain `.jsonl` before append. Upstream also gives
plain `.jsonl` precedence when both representations exist.

YA should mirror the same logical identity rule:

- the canonical rollout identity is the plain `.jsonl` stem;
- `.jsonl` and `.jsonl.zst` are two representations of that rollout;
- if both exist, read the plain `.jsonl`;
- a compression transition must not make a session disappear.

## Current Gaps

Codex session support is correct for ordinary small local trees, but the
current shape has important scale and representation gaps:

- The durable `rollout file -> session_meta` catalog exists as a
  provider-neutral discovery index. It now detects common replacement and
  shrink/truncation cases through source fingerprints and cached file size,
  but a same-path overwrite that keeps the same file identity and
  non-shrinking size can still keep cached head metadata until a stronger
  validation pass exists.
- `CodexSessionScanner` now records project-scan metrics and slow logs for
  file walking, discovery-index behavior, plain/zstd precedence, and
  cache-backed compressed discovery. `FileWatcher` now records rescan duration,
  files walked, emitted create/modify/delete counts, overlap skips, and
  adaptive periodic-rescan delay. `CodexSessionReader` now records
  session-list scan metrics for shared-cache status, file walking,
  discovery-index behavior, plain/zstd precedence, parsed/skipped metadata,
  and filtered subagent sessions.
- `session_meta` is effectively append-immutable, and the Codex adapter now
  reuses cached metadata across ordinary append/mtime/size changes.
- Recursive discovery is still O(number of rollout files). Date-bucket layout
  is not yet used as a first-class pruning/indexing primitive.
- Provider archived sessions are not modeled as a first-class YA source. Codex
  has an archived-session concept; YA's ordinary Codex session path currently
  centers on the configured active sessions directory.
- Compression is a representation detail, but YA must not pay whole-transcript
  decompression cost just to rediscover head metadata. Because YA still
  declares Node `>=20.12`, `.jsonl.zst` rollouts are supported only when the
  active Node runtime exposes native `node:zlib` zstd APIs; older runtimes skip
  compressed rollouts cleanly.
- The session id visible in YA must remain explicit. Provider-native resume
  handles, filename ids, and `session_meta.id` mappings must not silently swap
  the user-facing YA session id without a documented provider contract.
- Provider-child discovery is an unbounded read surface today.
  `CodexSessionReader.listProviderChildSessions` bypasses the streaming
  `readAgentMappings` projection and calls full `readEntries` with caching
  disabled. Because the process-list route invokes it for every active and
  recently terminated row, client `session-updated` revalidation repeatedly
  parses unchanged parent rollouts. This is the demonstrated owner of the
  2026-08-04 sustained server CPU incident, not a speculative scanner cost;
  see [provider-child-sessions](provider-child-sessions.md) for the correction
  contract.

## Near-Term Direction

The next durable improvements should build on the provider-neutral discovery
index without letting it diverge from provider-owned history:

1. Add an explicit validation strategy for same-identity, non-shrinking header
   overwrites. Current source-fingerprint and shrink checks cover common
   replacement/truncation cases without rereading ordinary appends.
2. Extend metrics and watcher-path coverage around canonical-stem
   rename/compression/delete reconciliation; scanner tests and metrics now
   cover a `.jsonl -> .jsonl.zst` transition preserving the session.
3. Re-read head metadata only when the rollout is new, cached metadata is
   missing or invalid, the file appears replaced/truncated, or an explicit
   validation pass marks the cache suspect.
4. Extend scanner instrumentation before broadening scope: dirty scopes and
   skipped date buckets once date-bucket probing exists.
5. Replace full-entry provider-child discovery with one shared, versioned
   child-summary projection. Coalesce identical in-flight versions, retain only
   child lifecycle facts, and inspect ordinary appends incrementally.

Invariant: the discovery index is derived and non-authoritative. YA must first
observe a provider file and only then reuse indexed metadata for that file. A
deleted or rotated provider file must disappear from YA lists immediately even
if its discovery shard still contains a stale record.

This keeps YA faithful to Codex's local transcript model while preserving the
resource-quiescence requirement from
[architecture-mandates](architecture-mandates.md).
