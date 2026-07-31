# Restart / Handoff Template

Topic: restart-handoff-template

The text a fresh session receives as its first user message when a running
session is restarted or handed off. Built server-side by
`buildRestartHandoff` / `buildRestartTranscript` in
`packages/server/src/routes/sessions.ts`, seeded via `startSession` from the
`POST /projects/:projectId/sessions/:sessionId/restart` route (handoff mode).

Distinct from two neighbours:
- **fork** mode copies the real provider transcript into a new session; it does
  not use this template.
- [`forged-transcript-handoff`](forged-transcript-handoff.md) is a proposed
  *replacement* for this template (write a filtered provider-format transcript
  and resume it). This doc governs the template that ships today.

Related: [`compact-and-handoff`](compact-and-handoff.md),
[`session-context-actions`](session-context-actions.md),
[`session-reactivation`](session-reactivation.md).

## Why lean matters here

At handoff time the user often **cannot compact** (over provider quota), so no
`## Provider-Native Compact Summary` is present and this template is the *sole*
recovery payload. Every token spent on framing noise is a token unavailable to
real recent turns. The template therefore optimizes for signal density, and
leans on a pointer back to the source session for any detail it drops.

## Slimming contract (implemented)

The activity/transcript projection keeps only what a successor can act on
without the (dropped) tool output:

**Kept**
- Recent **user turns** — verbatim, the load-bearing directions. A light
  `### user` divider separates them; timestamps removed.
- Real **assistant prose** (conclusions/explanations the agent wrote).
- **Shell commands** (`Bash`/`shell` tools) rendered bare as `$ <command>` —
  the one tool class whose intent reads without its output.

**Dropped entirely**
- All timestamps (were on every turn/tool line).
- **Non-shell tool_use** lines (`Read`, `Edit`, `Write`, `WriteStdin`, …) — the
  call detail is in the source jsonl, not here.
- All **tool_result** lines (the `output omitted (N chars)` placeholders).
- All **thinking** blocks/placeholders.
- Per-item `### role`/timestamp headers in the **activity** section — assistant
  prose and `$ commands` are self-delimiting under the section header.

Rationale for aggression: detail is recoverable from the source jsonl (see
*Provider hint* below), so the handoff need not carry it.

Code: `summarizeToolUse` (shell-only), `renderRestartActivityContent`
(results/thinking → `""`), `formatRestartMessage` (bare activity, `### user`
divider), `shellCommandFromInput`. Size budgets remain the `RESTART_HANDOFF_*`
constants (40k total); slimming frees room within the same caps.

## Source Session block (implemented)

```
## Source Session

- Session ID: <id>
- URL: <the client URL the user was on>    (omitted if absent/invalid)
- Project path: <path>
- Provider: <provider>
- Model: <model>
- Full transcript (read or grep for detail …): <path>   (omitted if unknown)
```

- **URL replaces the internal process id.** The client passes
  `window.location.href` as `sourceUrl` in the restart body
  (`RestartSessionModal` → `api.restartSession`); the server validates it to a
  single `http(s)` token (`formatRestartSourceUrl`) and renders it verbatim. It
  is self-documenting and clickable/resumable, unlike `Previous YA process:
  <uuid>`.
- **Transcript pointer** (see below) is emitted here as a `- Full transcript
  (read or grep for detail beyond this summary): <path>` line.
- **Dropped:** the `- Provider-native compact: …` status line (the compaction
  *attempt* still runs for its boundary effect — `tryRestartCompact` — its
  status is just no longer echoed) and the `- Restart reason:` line (always
  "Manual restart from Yep Anywhere" — no signal).

## Provider transcript pointer (implemented)

The provider's **reader** — not the runtime `AgentProvider` — owns transcript
storage, so the pointer comes from `ISessionReader.getSessionFilePath(sessionId)`
(`packages/server/src/sessions/types.ts`), the same optional method already used
for cloning. It returns the source session's on-disk `.jsonl` (or `null`).
Layouts differ per provider, which is why it's reader-owned:
- Claude: `<sessionDir>/<sessionId>.jsonl` (added to `ClaudeSessionReader` in
  `reader.ts` — the one reader that lacked it; probes every `allSessionDirs`
  candidate and stats for existence).
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (scan by id).
- Pi: `~/.pi/agent/sessions/--<cwd>--/<ISO-ts>_<uuid>.jsonl` (scan by id).
- opencode: DB-backed → returns `null` → no line.

Wiring: the restart route resolves the source reader via `resolveSessionReader`
(the renamed general resolver, formerly `…ForAgentContent`), calls
`getSessionFilePath(sessionId)`, and threads the result to `buildRestartHandoff`
as `sourceTranscriptPath` (rendered by `formatRestartTranscriptPath`).

The pointer references the **source** session and is a plain host file read, so
it works even when the fresh session switches provider. Absent/`null` → no line.
This is what *licenses* the aggressive slimming above: full fidelity stays one
grep away.

## User-highlight marking (proposed, postponed)

**Not scheduled.** Design as agreed:

- **Motivation.** When handing off, the user highlights the region they care
  about. Since the handoff carries only the last-N turns and the highlight is
  almost always within that already-included region, no separate composer field
  is needed (an earlier "editable prefilled field" idea is superseded) — mark it
  **in place**.
- **Marking.** Wrap the highlighted span in regular XML-ish tags, e.g.
  `<user-highlight>…</user-highlight>`. Highlights can be intraline, so the
  tags are ordinary inline markers (split lines or inline as needed), not
  line-oriented open/close delimiters.
- **Granularity: message-range.** The browser selection is over the *rich* chat
  UI, but the handoff is a *summarized* projection, so an exact character span
  won't reliably appear verbatim. Identify which messages the selection
  intersects (via DOM message ids), include them, and wrap that message range.
  Optional substring-narrowing only when the selected text still appears in the
  rendered message; never rely on it.
- **Window extension.** If the highlighted region starts before the normal
  last-N cutoff, extend the included range backward so the whole highlight is
  present (bounded by `RESTART_HANDOFF_MAX_CHARS`).
- **Transport.** Client passes the selected message-id range (and optionally the
  selected text) in the restart body, alongside the existing `sourceUrl`.

## Tests

`packages/server/test/routes/sessions-metadata.test.ts` — "summarizes fallback
activity and appends queued turns last" asserts the slim format (URL line,
transcript-pointer line, `$` bash command kept, prose kept; timestamps /
non-bash tool_use / tool_result / thinking dropped) and is the guard for this
contract.

`packages/server/test/session-sandbox.test.ts` — "reconstructs a private
transcript reader after metadata reload" covers `ClaudeSessionReader
.getSessionFilePath` (found in an additional dir; `null` for a missing id).
