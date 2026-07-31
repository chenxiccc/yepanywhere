# Backward compatibility decisions

Durable decisions for observable or persisted surfaces whose compatibility
handling is not obvious from the implementation alone.

Topic: backward-compat

## Decisions

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
