# Restore Codex ViewImage Rematerialization

> Consume provider-owned inline image candidates before session-detail
> projection drops private normalization metadata, while keeping provider
> caches isolated from response-only mutation.

Topic: session-media-handles

Status: implemented and validated on 2026-08-24.

Related contracts and records:

- [`topics/session-media-handles.md`](../../topics/session-media-handles.md)
- [`topics/stream-persisted-render-parity.md`](../../topics/stream-persisted-render-parity.md)
- [`topics/provider-output-contract.md`](../../topics/provider-output-contract.md)
- Retired gap: `gaps/codex-view-image-media-unavailable-after-revisit.md`

## Incident

On 2026-08-24, session `01a0287d-65d1-76a1-9717-080815c21209`
displayed four consecutive Codex `ViewImage` results as **Image unavailable**.
The session-detail response described every result as rejected with
`source-unavailable`.

The matching provider rollout still contained an inline PNG data URL for each
`custom_tool_call_output`. Decoding those authoritative values produced four
valid 1280x1024 PNGs of 497,352, 525,429, 511,268, and 511,748 bytes. Provider
persistence had therefore not lost the image data, and transient-handle expiry
was not the cause.

The tool-input paths also still existed in the host's macOS per-user temporary
directory, but the local-image route rejected those paths because the default
file-access allow-list named `/tmp`. That is a separate path-only availability
issue. Inline bytes were already available and should have made path fallback
unnecessary in this incident.

## Root Cause

Codex normalization sanitizes inline image data out of ordinary tool-result
fields and attaches the extracted candidate to the normalized message under
the private `TOOL_RESULT_MEDIA_CANDIDATES` symbol. The media materializer later
consumes that candidate, validates and decodes the bytes, and returns a small
fetchable descriptor.

Commit `c0f967a0e1` added `structuredClone()` in session detail before
route-specific augmentation so cached provider messages could not be mutated.
That isolation is required, but structured clone intentionally omits
symbol-keyed properties. The regressed route executed this order:

```text
normalize provider output
  -> attach private inline candidate
  -> detach response with structuredClone (candidate disappears)
  -> materialize media (only the tool-input path remains)
  -> report source-unavailable
```

A reproduction using the four incident entries produced four valid `stored`
handles when materialization ran on normalized messages and four
`source-unavailable` results after detachment. Symbol inspection showed
`Symbol(ya.tool-result-media-candidates)` before the clone and no symbols
afterward.

The direct materializer test did not catch the regression because it stopped
at `normalizeSession()` followed immediately by `materializeMessages()`. The
Markdown projection tests covered cache isolation through the route, but had
no private normalization metadata that the clone could discard. No test owned
the complete persisted session-detail-to-media-fetch path.

## Decision

Materialize authenticated historical tool-result media after pagination but
before generic response detachment. The materializer is copy-on-write: it
reads normalized tool-use/result messages and returns replacement result
messages without mutating the provider-reader or normalization cache. The
route then detaches the materialized window before pruning or presentation
augmentation can mutate nested objects.

The corrected order is:

```text
normalize provider output
  -> select the authorized response window
  -> materialize inline candidates into bounded handles
  -> detach the small response projection
  -> add route-only presentation fields
  -> return descriptors; fetch bytes through the media route
```

This keeps inline base64 out of session JSON, relay traffic, and the detached
clone. It also preserves the reason for `structuredClone()`: every later
route-specific mutation still acts on an isolated projection.

Do not broaden the macOS allow-list as part of this correction. A path-only
result may need a separate exact temporary-root policy, but filesystem access
is neither required nor sufficient when provider persistence supplies inline
bytes.

## Implementation Result

Session detail now materializes the selected authenticated history window
before detaching it. Public-share behavior remains unchanged. The materialized
messages are still detached before task pruning and persisted-render
augmentation, so cached provider objects never receive route-owned fields.

The regression fixture uses the same durable Codex code-mode shape as the
incident, supplies a valid inline PNG, and points `ViewImage` at a nonexistent
file. It loads the same cached provider session twice, proves both responses
return the same valid `stored` handle, proves the cached normalized result was
not mutated, proves no data URL reaches session JSON, and fetches the expected
PNG bytes through the media route. The test failed before the ordering change
with `rejected/source-unavailable` and passes afterward.

The owning topic now makes the response-projection boundary and route-level
test obligation explicit. The matching gap is deleted in the implementation
commit because the complete rematerialize-and-fetch path is covered.

## Implementation Order

### 1 — lock the persisted Codex media route regression

Add a server test with the incident's durable `custom_tool_call` and mixed
`custom_tool_call_output` shape. Give the tool a nonexistent source path so the
test can succeed only from the inline candidate. Exercise session detail,
assert that no data URL escapes, and fetch the returned handle through the
authenticated media route.

### 2 — consume media before response detachment

Move historical materialization ahead of `detachSessionMessageProjection()`.
Keep public-share behavior unchanged and detach all materializer output before
task pruning or persisted-render augmentation.

### 3 — publish the projection-boundary invariant

Record in the owning session-media topic that private ingest metadata must be
consumed before generic cloning or serialization, that materialization must be
copy-on-write, and that route coverage must prove the returned handle is
fetchable.

### 4 — close the incident with validation evidence

Run the focused media and session-route tests, server typechecking, lint, and
format verification. Delete the matching gap in the same commit once the
regression is fixed, then update this tactical with the landed behavior and
validation results.

## Validation

- `pnpm --filter @yep-anywhere/server test test/routes/sessions-metadata.test.ts test/media/tool-result-media.test.ts`
  — 107 tests passed with no warnings.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with zero warnings.
- `pnpm format:check` — passed.
- `git diff --check` — passed.

The correction uses existing platform-neutral object and media-store APIs. The
regression intentionally requires no readable source path, so it does not
inherit the current host's temporary-directory allow-list behavior.
