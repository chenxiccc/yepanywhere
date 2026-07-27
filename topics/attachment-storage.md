# Attachment storage

> Where YA writes user-uploaded attachments: project-relative `.attachments/`
> by default, kept uncommittable via `.git/info/exclude`, with a confined
> data-dir fallback when that is unsafe — surfaced as a configurable
> storage-location setting.

Topic: attachment-storage

Naming note: this file is what an earlier discussion called
"attachment-default-and-config"; `attachment-storage` is the shorter,
greppable `Topic:` namespace for the same contract.

## Motivation

Two schemes, and why the default moved:

- **Old (data-dir):** `~/.yep-anywhere/uploads/<base64url(project)>/<session>/`.
  Bytes live entirely inside YA's private data dir, never in the repo —
  confined and trivially wipeable, but **undiscoverable**: a TUI, a peer agent,
  or the running Claude process in the same project cannot find an uploaded
  file. The base64 dir name is only filesystem-safe namespacing, not a security
  feature.
- **New (project-relative):** `<project>/.attachments/<session>/`
  <!-- verified: uploads/manager.ts:10,121-126 -->. Discoverable — the agent
  prompt literally lists `User uploaded files in .attachments:\n<path>`
  <!-- verified: supervisor/Process.ts:1693; sdk/messageQueue.ts:299 --> so any
  tool with the working tree can `cat`/Read the file. This discoverability is
  the whole point.

**The one genuine regression** the data-dir scheme structurally avoided: in-repo
bytes can be swept into `git add -A` and pushed to a public remote, and pasted
screenshots may carry secrets/PII. Some users routinely add-all-and-push.
Everything below mitigates exactly this.

Path traversal / symlink escape are at parity between the schemes (UUID-prefixed
filenames, `realpath` + prefix containment, media-extension allowlist) and are
not the concern here; the write-into-the-repo leak is.

Tool-result media is deliberately outside this contract. YA-managed output is
materialized under `<project>/.yep/tool-results/<session>/` (with a data-dir
fallback) and served by opaque session media handles. It must never be written
under `.attachments/`, listed as `User uploaded files in .attachments:`, or
automatically supplied to a later provider turn. See
[[session-media-handles]].

## Default resolution (setting unset)

Per project, at upload time:

1. **Non-git project** → `<project>/.attachments/<session>/`. No commit risk.
2. **Git repo, `.attachments` is tracked/committed** → data-dir fallback,
   `~/.yep-anywhere/uploads/<base64url(project)>/<session>/`. The repo author
   chose to version that dir; YA will not dump session uploads into a push-bound
   tracked path, and `.git/info/exclude` has no effect on already-tracked paths.
3. **Git repo, `.attachments` not tracked** → run the force-exclude step, then
   `<project>/.attachments/<session>/`.

**Force-exclude step.** Idempotently ensure `.attachments/` is listed in the
repo's `.git/info/exclude` — never the tracked `.gitignore` (Kyle's constraint:
YA does not edit the user's committed ignore file). `.git/info/exclude` is a
per-clone, uncommitted, invisible ignore that keeps new attachments out of
`git status` and `git add -A` without dirtying any tracked file. **Skip the
write when `.attachments` is already ignored by any mechanism** — the committed
`.gitignore`, a global `core.excludesFile`, or a pre-existing
`.git/info/exclude` line — detected with `git check-ignore -q
<project>/.attachments`; a redundant exclude entry buys nothing. (This repo is
the live example: `.gitignore` already lists `.attachments/`, so YA uses it and
adds no exclude entry.) This step gates every default-path `.attachments` write
and is **mandatory whenever the storage path is not manually configured**; for
an explicitly configured in-repo path it is applied best-effort but the user has
taken ownership.

**Two checks, distinct roles** — do not conflate them:

- `git ls-files --error-unmatch <project>/.attachments` (exit 0 ⇒ tracked) is
  the **location** gate. Tracked-ness — not ignore state — decides data-dir
  fallback (case 2): with the exclude in place, the only thing that can make
  `.attachments` unsafe is its already being committed.
- `git check-ignore -q <project>/.attachments` decides only **whether the
  exclude write is redundant** (above). It is not the location gate; an earlier
  design wrongly used it for that.

## Configuration — v1: a single global setting

First version is **global only**: one "Attachment storage location" value
applied to every project. Recommended home: Settings → **Agent context**
(attachments are agent context — files the agent reads and the prompt lists);
runner-up is Message delivery, but that pane governs delivery *timing*, and
`local-access` is network binding/auth, not file storage.

Value model:

| Value | Behavior |
|-------|----------|
| *unset* / "Project `.attachments/` (default)" | the resolution above |
| "`~/.yep-anywhere/uploads/…`" | **always** data-dir; appends `<base64url(project)>/<session>/` |
| *custom path* | always that path; appends `<base64url(project)>/<session>/` so projects don't collide |

Explicit values are honored **verbatim** — no smart fallback — because the user
asked for them. The data-dir option's label must state that the
`<encoded-project>/<session>/` subdir is appended, so it is not mistaken for a
flat shared dump. Selecting the top entry explicitly is identical to leaving it
unset; it is the smart default made visible.

UI: an editable combobox (dropdown with the two suggested entries plus a
"Custom path…" item that reveals a free-text field). Validate a custom path as
absolute (`/…`) or project-relative (no leading `/`, no `..`).

The attachment chip should show the in-repo `.attachments/<session>/` location
so users are not surprised that bytes landed in their tree; it already
special-cases the `.attachments` segment when building its serve URL
<!-- verified: client/AttachmentChip.tsx:71 -->. See [[relative-filenames]].

## Future: per-project override (motivation + possibility)

Deliberately **not** in v1. Motivation: a global setting cannot express that
*some* repos should never use in-repo storage even when `.attachments` is not
tracked — e.g. repos with aggressive `git add -A` habits, shared/public repos,
or trees synced to a cloud provider — while others want in-repo always-on. A
per-project override would let a project pin data-dir (or a custom path)
regardless of the global default, or opt back into `.attachments` where the
global default is conservative.

Possibility when built: store the override in per-project settings
(`session-metadata.json` or an equivalent project record) and resolve
per-project override → global setting → built-in default. v1 ships the global
setting alone because it is simpler and sufficient; this section records the
intended extension so the global value's shape does not foreclose it.

## Serve surface (read path)

Attachment **display** goes through the dedicated narrow route
`/api/projects/:projectId/sessions/:sessionId/upload/:filename`
<!-- verified: routes/upload.ts:301-337 -->, which requires a UUID-prefixed
filename and checks the new `.attachments` dir then the legacy data-dir. That
route is equally tight for both schemes.

The broad `/api/local-image` and `/api/local-file` routes allow-list **every
scanned project root** <!-- verified: routes/local-resource-policy.ts:119-146 -->
and exist for rendering local media referenced in agent output / Markdown — they
are **not** caused by the `.attachments` move. The only new interaction: a
project-relative attachment now also sits under an already-allow-listed project
root, so it is additionally reachable via those routes (allowed extensions only,
and behind YA auth either way). See [[security]] for the trust-boundary contract
on those routes.

## Deferred: retention / cleanup

**Not built.** Old data-dir attachments were trivially bulk-wiped under one
directory; in-repo attachments scatter across repos. Future **when-needed
suggestion trigger**: when a project's `.attachments/` grows large or old,
surface a cleanup affordance (per-session and per-project clear; age/size
pruning) rather than building eager retention now. Record here so the trigger is
not reinvented.

Pre-session attachment staging is tracked separately in
`docs/tactical/028-pre-session-attachment-staging.md`. That plan uses the YA
data dir only as a temporary staging area before a real session exists; it does
not change this topic's final attachment storage behavior.

## See also

- [[security]] — local-file / local-image serve allowlist and the
  local-vs-public trust boundary.
- [[relative-filenames]] — chip display of the in-repo `.attachments/<session>/`
  path.
