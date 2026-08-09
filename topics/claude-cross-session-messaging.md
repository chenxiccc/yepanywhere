# Claude Cross-Session Messaging And YA Delegation

> Claude Code cross-session messaging is a useful live-session communication
> primitive and Agent View is a useful local supervision UI reference. Neither
> is the host trust, launch, or control plane YA needs for cross-host
> delegation.

Topic: claude-cross-session-messaging

Status: comparison and product direction. The Claude behavior below was
checked against the official documentation on 2026-08-09, when cross-session
messaging required Claude Code 2.1.224 or newer. YA has not yet implemented a
cross-host coordination API or committed to using Claude's native messaging
inside its Claude adapter.

Related:
[cross-host delegation](cross-host-delegation.md),
[provider child sessions](provider-child-sessions.md),
[core service API](core-service-api.md),
[federated super sessions](federated-super-sessions.md), and
[architecture mandates](architecture-mandates.md).

Sources:
[Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
and
[Claude Code Agent View](https://code.claude.com/docs/en/agent-view).

## Why Compare Them

Both systems can be described casually as one agent coordinating another, but
their primary objects differ:

- Claude cross-session messaging addresses a currently reachable Claude Code
  session and delivers text to it.
- YA cross-host delegation addresses an authorized YA server, asks it to
  create or select a native worker session, and supervises that work through a
  durable relationship.

The distinction matters because adopting a provider feature does not answer
how a Mac YA server learns that a Windows or Linux YA server exists, what it is
allowed to do there, how it launches a worker, or how a Codex controller and a
Claude worker participate in the same product.

## Claude's Model

Claude Code exposes `ListAgents` and `SendMessage`. Independent eligible
sessions on the same machine register an inbox and can discover and message
one another. Messages are plain text, not transcript, context, or file
transfer. A busy recipient reads accepted messages between tool calls; an idle
recipient may start a new turn to handle one. Delivery can be accepted, held,
or refused by the receiving session's policy.

Local messaging uses registration files and a per-session Unix-domain socket.
The operating-system user and socket permissions form the local reachability
boundary. Containers need an explicitly shared registry and socket path if
they are meant to participate.

Cross-machine visibility is narrower. The documented path uses Anthropic's
Remote Control service, and remote or web sessions can reply to an exchange
but cannot initiate one. Eligibility also depends on Claude's provider,
account, configuration, and platform support. This is not an arbitrary set of
mutually authorized machines, and native Windows is not currently supported.
In particular, discovery is not simply a global roster of every active agent
owned by one logged-in Claude user: local registry visibility and an active
Remote Control relationship determine which independent sessions appear.

Incoming peer text is intentionally not human authority. It cannot approve a
permission request, change the receiver's settings or permission mode, edit
`CLAUDE.md`, or execute a slash command merely by spelling one. The receiving
session's permission rules still apply. Claude also provides queue bounds,
repeat suppression, and loop rate limiting.

### Independent sessions, subagents, and teams

`SendMessage` is shared vocabulary across several Claude features, but the
relationships remain distinct:

- a subagent is created inside a parent session's provider runtime;
- an Agent Team has a lead, teammates, a shared task model, and team lifecycle;
- cross-session messaging connects otherwise independent reachable sessions;
  and
- `ListAgents` covers local and Remote Control sessions plus the current
  session's subagents, while team membership uses the team's own roster.

Cross-session messaging therefore is not merely the Agent Teams protocol, but
it also does not turn all of a user's machines and sessions into a general
control plane. It is primarily presence, addressing, and text delivery among
eligible live Claude sessions.

### Agent View

Agent View is a separate local Claude feature with a product shape that is
highly relevant to YA. It can list background sessions, show status and recent
activity, accept input, attach to a full conversation, and detach back to the
overview. Its supervisor and workers are local to one machine and Claude-only,
but its list/peek/attach/back interaction is a strong reference for YA's
multi-host session UX.

## Comparison

| Concern | Claude cross-session messaging | YA cross-host delegation |
| --- | --- | --- |
| Primary address | Reachable Claude session | Stable authorized YA peer, then a target-owned YA session |
| Discovery | Live local inbox registry; limited Remote Control presence | Durable adjacent peer records, directional grants, and reported capabilities |
| Launch | Does not generally create the independent recipient | Creates a normal native worker through the target YA server |
| Providers | Claude Code | Provider-neutral; Claude and Codex are first-class |
| Machine topology | Machine is a reachability boundary, not a durable trust graph | Host identity and directed controller/worker relationships are product concepts |
| Default remote path | Anthropic Remote Control with asymmetric initiation | YA's encrypted relay circuit and peer-scoped grant/resume relationship |
| Payload | Plain text | Structured launch, state, progress, attention, control, result, and bounded messages |
| Lifecycle | Deliver, hold, refuse, and reply | Start, observe/wait, steer, answer, interrupt, abort, and release |
| Durable state | Live-session registration plus provider transcript | Delegation record survives reconnects and names controller, peer, worker, and state |
| Project semantics | Left to message content and the agents | Target project discovery and mechanical preflight; agents still own Git decisions |
| Authority | Peer message is untrusted agent input | Grant and target policy bound by YA; peer message still is not human approval |
| User navigation | Agent View is local and Claude-only | One UI can list a controller's workers and open their native sessions across YA hosts |

## The YA Authority Boundary

YA should preserve the same useful security distinction even when it does not
use Claude's implementation:

- a controller agent's message to a worker is peer-authored instruction, not
  authenticated human instruction;
- a user who opens the worker through YA and writes directly is an
  authenticated human acting through that target session;
- the outgoing grant, incoming grant, worker policy, and provider permissions
  form a ceiling that agent messages cannot raise; and
- a controlling agent cannot approve a worker's permission request on the
  user's behalf merely because it created the delegation.

Provenance must survive normalization. YA may say that a message came through
a verified peer relationship, but that proves the sending server and
delegation—not that arbitrary text inside the message came from the human.

## How YA May Use Claude's Feature

Claude's native feature should be treated as an optional provider capability,
not as YA's coordination protocol.

Once YA has created a Claude worker, native messaging could be useful for
Claude-to-Claude communication on the same host or wherever Claude officially
supports it. YA should first verify that SDK-launched sessions expose the
feature, that peer-origin events are preserved in the SDK stream, and that the
relevant permission modes remain usable for unattended workers.

YA must not write directly to Claude's private inbox socket, forge its local
peer provenance, or route a remote YA peer through that socket as though it
were a kernel-authenticated local process. YA's own coordination service still
owns:

- peer discovery, relay transport, pairing, grants, and revocation;
- target project inspection and worker creation;
- provider-neutral observation, lifecycle control, and durable results;
- browser navigation and authentication across YA hosts; and
- equivalent behavior for Codex and future providers.

If native Claude messaging and YA messaging are both available, the adapter
needs one explicit delivery path per operation. It must not duplicate a user
message through both channels or create two competing supervision histories.

## UX Direction: Separate Sessions, Unified View

The practical first YA experience does not require transcript migration or a
full super-session jump. A controller and each worker remain separate native
YA sessions. The controller UI can show its delegated workers, their hosts,
providers, state, last activity, and attention needs. Selecting one opens that
worker's full session; a stable breadcrumb or back action returns to the
controller.

This is closer to extending the useful parts of Agent View across hosts and
providers than to making one session teleport between machines. A browser
that already has an authenticated route to the worker host can switch sources
directly. Otherwise it performs normal browser-to-host authentication or a
future narrowly scoped viewing flow. A server-to-server delegation grant must
not silently become a browser-wide login.

For sequential cross-platform work, the delegation relationship should carry
enough structured evidence for a controller to enforce a commit handoff:

```text
Mac controller commits and pushes C0
  -> Linux worker checks out C0, validates or fixes, pushes C1
  -> Windows worker checks out C1, validates or fixes, pushes C2
  -> controller fetches C2 and reviews the accumulated evidence
```

Each worker can report its starting commit, resulting commit, pushed ref, and
validation evidence. YA provides facts and assertions; the agents decide how
branches, worktrees, dirty checkouts, and conflicting changes should be
handled.

## Version Posture And Probes

The official cross-session messaging documentation currently requires Claude
Code 2.1.224 or newer. YA's committed compatibility marker predates that
version, so support must be audited during a later Claude provider refresh
rather than assumed from the documentation alone.

Before choosing a Claude adapter strategy, probe:

1. whether an SDK-managed YA session registers an inbox and exposes
   `ListAgents` and `SendMessage` without a TUI;
2. how incoming peer origin, delivery state, held messages, and replies appear
   in SDK events and persisted transcripts;
3. whether YA can assign stable, unambiguous provider session names without
   replacing canonical YA session ids;
4. how cross-session inbound policy interacts with YA's permission modes and
   unattended execution;
5. whether inbox presence and Remote Control introduce background activity
   that conflicts with YA's idle-resource mandates; and
6. whether the native path materially improves same-host Claude coordination
   enough to justify a provider-specific adapter rather than using YA's common
   coordination service for every message.
