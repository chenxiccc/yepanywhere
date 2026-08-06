# Backward compatibility decisions

Durable decisions for observable or persisted surfaces whose compatibility
handling is not obvious from the implementation alone.

Topic: backward-compat

## Decisions

2026-08-06 frozen public-share relay transport — releases `v0.5.2`, `v0.6.0`,
`v0.6.1`, `v0.6.2`, and `v0.7.0` expose only a materialized one-response
public-share relay path. Add the exact secret-authorized metadata capability
`public-share-session-chunks-v1` for bounded 256 KiB compressed pull requests
over the existing relay request/response framing. Marked v2 metadata without
it keeps `wire=raw-json` and makes no chunk request; unmarked links keep the
combined request and make no metadata or chunk request. Existing capability
meanings and `#v=2` remain unchanged. A browser without
`DecompressionStream` uses the same-socket raw-json fallback even when the
metadata capability is present. New clients require exact success statuses and
runtime-validate each artifact before publishing it: compact metadata may
publish before the body, while a raw or decompressed complete session validates
before session publication. A pre-auth socket selects one lifetime mode: its
first public read locks it to public-read-only, while any SRP control attempt
locks it to SRP even when authentication later fails. Request responses keep the framing
selected at admission rather than consulting later mutable auth state.
Public-read-only sockets allow one request in flight; a second request aborts
and closes as a protocol violation, while authenticated relay multiplexing
remains unchanged. Chunk transfer is available only for safe integer compressed
and decompressed lengths up to 64 MiB. Oversized historical revisions remain
structurally valid but are not chunk-capable: they omit the capability, so a
conforming client sends no chunk request and uses `wire=raw-json`. Relay
raw-json succeeds only through 8 MiB; a larger response returns 413 with update
guidance. Direct HTTP streaming can still load a larger structurally valid
revision. Cap every pre-auth public-share response in the WebSocket adapter at
8 MiB. The adapter retains no more than the accepted 8 MiB body plus
one logical inspection byte. Controlled combined/raw-json serializers emit at
most 64 KiB per source chunk, so cancellation may consume at most one such
bounded chunk past the accepted prefix; an unexpectedly unbounded controlled
producer chunk is an internal invariant failure. Other public resources use
declared length only as an early rejection and enforce the streamed count as
the hard bound; overflow returns 413 without broadening the session-chunk
capability to files. Direct HTTP public-share streams, authenticated relay
traffic, and unrelated relay routes remain uncapped by this adapter policy.

2026-08-05 public-share grants and compact URLs — preserve every
legacy 64-byte/86-character bearer secret and display-hint fragment while new
links use a 16-byte/22-character secret plus a compact protocol marker and
server-persisted header. Old viewers ignore the marker and keep using the
combined response; new viewers use legacy fragments and do not call the new
metadata route for an unmarked link. Gate global inventory and opaque-id
revocation behind the new `public-share-management` capability so older
servers receive no unsupported management request.

2026-08-05 public-share owner copy — retain the exact URL for new grants and
return it as an optional authenticated inventory field; pre-change and migrated
hash-only grants remain valid and revocable but cannot offer copy because their
bearer secret is unrecoverable. New clients treat an absent URL as a disabled
copy action, so supported older servers require no new request or response
shape.

2026-08-04 `idleReapHours` settings contract — advertise the optional field
with the permanent `idle-reap-hours-setting` capability. New clients hide the
control and make no settings write against older servers. Until an operator
saves the field, the legacy `IDLE_TIMEOUT` environment value remains
authoritative; saving opts the deployment into the persisted setting.

2026-08-04 reload-safe runtime viewer presence — retain host protocol v1 and
advertise viewer-state retention as an optional additive lifecycle capability.
A replacement Hono may attach to a host already running older v1 code and use
generation-local viewer timing; capable hosts preserve viewer-absence evidence
across Hono reloads. Older Hono generations ignore the added runtime fields and
never issue the new operation.

2026-08-03 project-directory storage — a server that first implements
`project-directory-storage-policy` defaults absent configuration to app-data
storage, but does not migrate, rewrite, exclude, or delete legacy
`.attachments`, `.yep`, or `refs/yep/*` state during upgrade. Legacy data may
remain readable without permission to refresh or grow it. Older servers lack
the capability and may retain their historical project-write behavior; newer
clients omit the unsupported setting and explain that an update is required to
enforce app-data-only storage.

2026-08-01 `.yep/review-comments.json` version 2 — migrate every valid
version-1 draft, archived comment, and batch into canonical sites, reviewer
entries, active-draft references, and submission summaries before persisting
new submission manifests. Migrated entries use `legacy-missing` rather than a
fabricated current-file capture. The established review-comments endpoint
continues returning its version-1 comments/batches projection for older
clients; only active drafts count toward the 2,000-comment creation limit.

2026-07-31 Source Control action commit counts — add optional
`commitsAdvanced` fields to the existing Pull and Push responses without a new
capability. Released capable servers `v0.6.0`, `v0.6.1`, `v0.6.2`, and
`v0.7.0` omit the field; newer clients preserve the generic success feedback
for those responses and make the same already-capability-gated request. Newer
servers supply exact fast-forward Pull counts and the immediately observed
pre-push ahead count; older clients ignore the additive field.

2026-07-28 blame `authorColorSeed` — add the hue preference as an optional
line field under the existing `git-source-review` capability rather than
expanding that capability or adding a request. Older servers omit it; the
client hashes the author name and runs the same visible-set spacing, so file
content, blame links, and review remain available without protocol probing.

2026-07-27 Claude Gateway `supported_endpoints` omission — treat an explicit
endpoint list as authoritative and omit models with no supported text
endpoint, but retain metadata-less rows for generic gateways and older
`copilot-api` catalogs that predate the extension. The gateway owns its legacy
route and any visible model-specific error; YA never falls through to regular
Claude. Current focused `copilot-api` catalogs preserve endpoint metadata, so
known Responses-only and Messages-capable models do not use this exception.

2026-07-27 `claude-ollama` provider/settings/session identity — retain the
legacy provider during a deprecation grace period and do not auto-migrate
persisted sessions or settings to `claude-gateway`. Hide it from provider
menus only when neither explicit Ollama configuration nor persisted
`claude-ollama` session metadata exists; direct provider lookup remains
available so old sessions can still resume. Existing users receive a
dismissible removal notice directing them to `claude-gateway`.

2026-07-25 previous/custom Claude model settings — persist selections on the
server and advertise one exact transitional capability. A new client hides the
control when an older compatible server lacks that capability, avoiding a
write the old settings parser would silently ignore. A new server's optional
provider metadata is additive for older clients. If a maintained registry item
is later removed, keep an existing saved exact id and label as unlisted/custom
instead of deleting or remapping it. This does not raise
`remoteCompatibilityLevel`.

2026-06-23 `session-metadata.json` — add optional transcript display objects in
schema version 2 while retaining all version-1 session metadata; the additive
migration preserves existing configured state, and interrupted generating
objects recover as errors because their in-memory jobs cannot survive restart.

2026-06-24 `PI_PATH` — rename the pi provider executable override to
`PI_EXECUTABLE` because the value is a full binary path, not a search directory;
keep `PI_PATH` as a startup-normalized legacy alias so existing launches still
resolve the same executable.

2026-07-03 `hasUnread` (REST session rows/detail) — compute unread from the
pre-recap-overlay `updatedAt` instead of the overlaid one, so a recap landing
never flips a fully-seen session unread; reverses the overlaid-freshness
choice in "Tighten recap overlay cursor and freshness handling" because a
YA-synthesized recap is derived viewer content, not new provider activity.

2026-07-04 `clientDefaults.sessionToolbarVisibility` /
`clientDefaults.sessionToolbarPriority` — replaced by a single
`clientDefaults.sessionToolbarPresence` map (`hidden` | narrowing tier) per
explicit direction that the toolbar data model carry no separate visibility
boolean; hiding forgets the prior tier. Stored state is folded in at load on
both sides (`ServerSettingsService.mergeLoadedClientDefaults`; client
localStorage migration in `useSessionToolbarPresence`), but the settings
PUT surface no longer accepts the legacy keys: a stale cached client sending
them gets 400 and logs a console warning until it picks up the new bundle.
Accept-and-translate was deliberately skipped as speculative scaffolding for
a transient skew.

2026-07-05 session-detail REST default / approval audit log — uncursored
`GET /api/projects/:projectId/sessions/:sessionId` now returns a
two-compaction tail unless `fullHistory=1` is explicit, and approval decision
logging now defaults off behind `approvalAuditLogEnabled`. The session-detail
flip is the server-side safety backstop for tactical 055/SPC-007: the current
client source API requires a bound or explicit full-history request and handles
pagination, while stale cached or out-of-repo clients that relied on the old
unbounded default now get a bounded window and must opt in to full history.
The audit-log flip favors privacy/explicit operator intent over implicit
security logging; older clients cannot enable it without the capability-gated
settings surface.

2026-07-10 session-detail turn selectors — `tailTurns` and `tailFrom` narrow
the default or explicitly requested compact-tail scope; they do not replace it.
Only `fullHistory=1` authorizes those selectors to reach across older compact
boundaries. This closes a regression where the client's implicit
`tailTurns=20` safety cap disabled the two-compaction REST default and could
return a full Codex transcript with fewer than twenty user turns.

2026-07-20 process-abort `resumeExemption` response — replace the
`rolloutsRenamed` / `failures` fields with `autoResumeDisabled` / `error` and
stop renaming provider rollout files; the short-lived former contract made an
explicit Kill hide history and prevent deliberate continuation, so preserving
that response shape would preserve the wrong mechanism. YA's co-deployed
client now distinguishes verified shutdown from exemption persistence failure.

2026-07-23 Pi RPC turn completion — use `agent_settled` for Pi 0.80.4 and
newer, but retain `agent_end` for version-probed 0.79.9 through 0.80.3
binaries because they never emit the newer event and would otherwise hang.
Fail startup when `pi --version` is unrecognized rather than guessing a
boundary that could either hang or finalize before retry/compaction completes.

2026-07-25 `clientDefaults.bangCommandsEnabled` — keep the persisted key and
routes but narrow its meaning from "all bang commands" to "the discoverable
!! Commands history surface" (sidebar entry + `GET /api/bang-commands`);
execution, completions, and session-scoped bang routes became always-on under
the vanilla-defaults established-convention carve-out. Key kept because it is
a persisted server setting named in the `bang-commands` capability contract;
older co-deployed clients that still gate the composer on it merely under-use
the server.

2026-08-05 progressive session catalog — gate the client's move from
request-complete session/Inbox enumeration to generation-reusing progressive
snapshots behind a permanent `progressive-session-catalog` capability, rather
than changing the existing responses in place. Permanent because YA is
self-hosted with no forced upgrade, so old servers persist indefinitely and the
gate never becomes removable. The approved obligation is a performance floor,
not a feature floor: an out-of-date client against a current server, and a
current client against an out-of-date server, must still perform basic actions
at some non-optimal performance level, so the ungated path stays a working
enumeration rather than a degraded stub. The server half now exists —
`GET /api/sessions` reports `generation`, accepts `knownGeneration`, and answers
`{ unchanged: true }` on a match — and is additive: an older server ignores the
parameter and returns a full response, so a client without the capability is
safe either way. The client half now sends the token behind the capability;
release corpus audited at that point was `v0.7.0` (2026-07-25), `v0.6.2`
(2026-07-11), and `v0.6.1` (2026-07-10) — no stable release advertises
`progressive-session-catalog`, so every released server takes the enumeration
fallback and receives no `knownGeneration`. No existing capability's meaning
changed. See [Server Capabilities](server-capabilities.md) § Session-catalog
gate.

2026-08-05 `.yepignore` — removed with the project path index's breadth-first
warm. The file was read only to narrow that crawl, so with no crawl it
configures nothing. It is user-authored project-local input, never a YA-written
file, and it never restricted lookup: a path under an excluded directory always
linked when the file existed. A project still holding one is unaffected, since
the index now hydrates only the directory components a displayed candidate
names. See [Project path links](project-path-links.md) § The index.
