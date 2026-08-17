# Nested Harness Launch

> A nested harness launch is one agent session starting a second harness
> process from a shell tool call, which YA links to the session that process
> writes by reading the launching command rather than provider subagent
> records.

Topic: nested-harness-launch

Related topics: [provider-child-sessions](provider-child-sessions.md),
[bash-result-contract](bash-result-contract.md),
[vanilla-defaults](vanilla-defaults.md)

## What this is, and what it is not

An agent can start a whole second harness process with a shell tool call —
`claude --resume <uuid> --print < task.md`, usually backgrounded — instead of
using the provider's own subagent feature. YA records both sides correctly and
independently: the launcher writes an ordinary Bash tool call, and the child
writes an ordinary top-level session transcript in the same project. Nothing in
either record says they are related.

This is not a [provider child session](provider-child-sessions.md) and not a
subagent. Subagent detection keys on `agentId` plus `isSidechain`, and these
transcripts contain no sidechain entries at all, because no subagent was ever
created. The child is a real YA session with its own canonical YA session id,
listed and openable like any other. Only the edge to its launcher is missing.

The Bash result's `backgroundTaskId` does not supply that edge. It names a
harness-local output file under the harness temp directory, not a session, and
it is unresolvable once that directory is gone.

## Discovery contract

`detectNestedHarnessLaunch` in `packages/shared/src/nested-harness-launch.ts`
is the single owner of reading a launch out of command text. It returns the
harness name, the session the launched process will write when the command
names one, and the directory an earlier `cd` moved to.

It recognizes a launch only when the harness is the command word of a simple
command and the invocation either names a session — `--resume`, `-r`, or
`--session-id` with a UUID-shaped value, attached or separate — or runs
non-interactively via `-p`/`--print`. `claude --version`, `command -v claude`,
and a `claude` substring inside an argument or a path are all not launches.

Two properties matter more than breadth of syntax coverage:

- **A quoted command is not an invocation.** The splitter tracks quoting and
  skips heredoc bodies, so a commit message or a written file that quotes a
  launch command does not produce a phantom edge. It deliberately does not
  descend into a quoted `sh -c '...'` argument, which therefore reads as no
  launch rather than as a guess.
- **Only a named session becomes a link.** A fresh launch reports the harness
  with no session id: the new id exists only in the harness's own task output
  file, which is temporary and process-scoped. Recovering it would need a new
  reader for that file and is not implemented.

Against every shell command in the local transcript corpus (25,457 commands,
2,061 of which mention `claude`), the detector reported 19 launches, all
genuine backgrounded harness runs, 9 of them carrying a resumable session id,
with no false positives.

## Presentation contract

`NestedHarnessLaunchLink` renders under the command in all three Bash views —
the tool-use view, the expanded result, and the detail modal — and renders
nothing at all when there is no session to link. `nestedHarnessLaunchTarget` in
`packages/client/src/lib/nestedHarnessLaunch.ts` decides that, and withholds a
link in three cases:

- the command names no session;
- the named session is the one being read, which is not an edge;
- the command first `cd`s outside the session's own project directory, because
  the child then belongs to another project and a filesystem path is not a YA
  project id.

The link carries the launched session's first eight characters and resolves
through the relay base path, so it works from the hosted remote client.

This is not YA-novel behavior under [vanilla-defaults](vanilla-defaults.md), on
the same footing as [provider child sessions](provider-child-sessions.md): it
restores visibility for work the user explicitly caused, adds no action and no
provider state mutation, and reuses YA's existing session navigation. It ships
always-on and adds no setting.

## Not covered

The reverse edge — a child session showing which session launched it — is not
implemented. It cannot be derived from the child's own transcript, so it needs
launch edges indexed across a project's sessions plus a server contract to
carry them, which is a client/server compatibility decision
([server-capabilities](server-capabilities.md)) rather than a rendering
concern. Until then a launched session still looks unattached when opened
directly, which
[`gaps/nested-harness-session-not-linked-to-launcher.md`](../gaps/nested-harness-session-not-linked-to-launcher.md)
tracks.

Only `claude` is recognized. Other harnesses' resume spellings are addable as
data in `HARNESS_NAMES` and the flag sets, but none has been verified against a
real transcript corpus here, and guessing a spelling would produce links that
silently point nowhere.
