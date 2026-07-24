# Public Share Content Censorship
> Public share content censorship is the proposed layer that scans and redacts
> secret-like transcript content before unauthenticated share viewers see it,
> because link stripping does not remove secrets already printed in tool output.

Topic: public-share-content-censorship

## Status

Proposal recorded. YA already avoids exposing assistant-text local-filesystem
links in public shares by default, and public file viewing is share-scoped
rather than routed through authenticated local file APIs. That is necessary but
not sufficient: a transcript can contain the sensitive bytes themselves.

Current interim mitigation: public share viewers show a caution that
assistant-visible `Read`, `Edit`, and command output should be considered public,
with stronger wording for live shares. This is only a warning; it is not a
redaction layer.

Until the censorship layer covers every display-object kind, frozen snapshots,
live responses, and per-viewer frozen snapshots omit
`transcriptDisplayObjects` entirely. In particular, local bang-command lines,
previews, and errors never reach public-share payloads. This conservative
interim boundary may hide benign fork-status links as well; authenticated
session views remain unchanged.

## Problem

Public shares expose transcript content to unauthenticated bearer-link viewers.
That content can include provider/tool output, not just assistant prose.

High-risk surfaces:

- `Read` results: even if filesystem links are hidden or rewritten, the selected
  file lines may already be visible in the transcript.
- Command stdout/stderr: `env`, build scripts, test logs, crash reports, and
  debug dumps can print API keys, tokens, cookies, private keys, or credentials.
- Provider summaries or assistant prose: providers usually avoid reading or
  repeating obvious secrets, but rare misses are expected over enough turns.

The invariant is therefore content-based, not route-based: public-share safety
cannot be proven by checking that local-file links are blocked. Any text that
will be rendered to the public viewer must be treated as a possible secret
carrier.

## Long-Run Contract

A public-share censorship layer should run on the share-visible transcript body
before it reaches public clients. It should cover the same rendered surfaces a
viewer can read, including plain message text, tool-result snippets, command
output blocks, rendered Markdown text, and generated previews.

The authenticated/local session remains unchanged. Censorship is a public-share
view/export transformation, with explicit placeholders where content was
removed. The viewer should see that redaction happened rather than receiving a
silently edited transcript.

The layer should be content-aware:

- Detect high-confidence secret formats such as private key blocks, common API
  token shapes, cloud credentials, OAuth tokens, session cookies, and `.env`
  assignment patterns.
- Use path/context hints to raise sensitivity, e.g. `Read .env`,
  `~/.ssh/id_*`, `*.pem`, `*.key`, `*.p12`, `*.kube/config`, and shell commands
  like `env`, `printenv`, or `set`.
- Redact a whole block when line-level confidence is not enough to avoid
  leaking the surrounding secret.
- Keep enough structural context for the share to remain understandable:
  command name, tool kind, line counts, and a reason label such as
  `[redacted: possible environment secret]`.

## Open Design Points

- Share creation vs. share serving: frozen shares could persist a censored
  transcript snapshot, while live shares need deterministic censorship on each
  served revision.
- Owner controls: decide whether owners can reveal redacted content, and whether
  that should require a private authenticated view rather than changing the
  public bearer-link output.
- False positives: prefer conservative redaction for public viewers, but make
  the reason visible so owners can diagnose why a share looks incomplete.
- Relay privacy: the censorship pass should happen before plaintext public-share
  relay payloads leave the YA server; see
  [`security.md`](security.md#public-share-relay-privacy).
