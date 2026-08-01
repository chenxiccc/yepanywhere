# Cross-Host Delegation

> Cross-host delegation lets an agent or user on one YA server start and
> supervise a separate, native YA session on another authorized YA server,
> without moving the controlling session or pretending the two transcripts are
> one conversation.

Topic: cross-host-delegation

Status: product direction. The user need, trust shape, and broad UI direction
are clear enough to record. Peer identity, pairing, the delegation API, project
mapping, and the worker-session presentation remain intentionally open.

Related:
[client source runtime topology](client-source-runtime-topology.md),
[relay client mux](relay-client-mux.md),
[core service API](core-service-api.md),
[federated super sessions](federated-super-sessions.md),
[remote executors](../docs/project/remote-executors.md),
[super-session testbed appliance](../docs/tactical/073-super-session-testbed-appliance.md),
[vanilla defaults](vanilla-defaults.md), and
[architecture mandates](architecture-mandates.md).

## Motivation

A user may have several YA servers on native or virtual macOS, Windows, and
Linux hosts. The browser can already save, authenticate to, and switch among
several relay-backed hosts, and the experimental `/-/monitor` surface can keep
several independently authenticated sources visible at once. Those hosts do
not yet know about one another, however. Each connection is a relationship
between one browser profile and one YA server.

The next useful step does not need full session migration. A controlling agent
on one server could give a bounded task to another authorized YA server. The
target would create a normal local YA session and run its provider harness,
checkout, shell, build tools, browser, and any available first-party computer
use on the target operating system. The controlling session would remain
active on its original host and receive progress and a result from the worker.

This is a middle layer between today's manual host switching or SSH Remote
Executors and the more ambitious super-session `jump`:

```text
manual host use
  user switches YA hosts and drives each session directly

cross-host delegation
  one YA session creates and supervises a separate session on another host

super-session jump
  the same canonical session transfers ownership and resumes on another host
```

Delegation also does not depend on a more powerful custom computer-use system.
The first experiments may use provider-supplied computer use with its existing
limitations. Guest-native computer control can evolve as a separate tool
surface.

## Three Host Sets

The product must preserve three related but different sets:

1. **Saved YA hosts in this browser.** These are hosts the user can open and
   drive manually through the YA interface. The browser owns their saved route
   and SRP resume state.
2. **Hosts this YA server can delegate to.** These are outgoing delegation
   targets for which the current server holds a server-to-server authorization.
3. **Hosts that may delegate to this YA server.** These are incoming
   controllers whose grants are enforced by the current server.

The same stable YA server may appear in more than one set, but the authorities
must not be collapsed. Forgetting a browser-saved host does not silently revoke
a server-to-server grant. Revoking delegation does not silently remove a
browser login.

User-facing copy should describe direction from the current server rather than
rely on the easily reversed nouns "delegator" and "delegatee":

- **This server can delegate to** for outgoing targets; and
- **May delegate to this server** for incoming controllers.

## Product Surface Direction

Host switching belongs in the main product surface rather than a growing
collection of Settings panes. The existing sidebar **Switch Host** action is
the natural entry point.

The first version should reuse the current developer-mode exposure for the
experimental all-hosts monitor:

- with the experiment disabled, Switch Host retains today's familiar host
  picker behavior;
- with it enabled, Switch Host opens an expanded multi-host surface based on
  `/-/monitor`;
- saved browser hosts and switching remain the prominent, first section; and
- delegation appears below as an explicitly experimental, initially collapsed
  section.

The host surface should keep the current host available until the user chooses
another host rather than disconnecting as the first step. Saved-host cards can
show bounded connection/authentication state and small activity summaries,
with **Switch**, **Sign in**, and **Add host** as the primary actions.

The expanded delegation section is scoped to the currently selected YA server:

```text
Your YA Hosts

Saved on this device
  Mac Studio        Current
  Windows VM        Connected                 [Switch]
  Ubuntu VM         Sign-in required           [Sign in]

Delegation                                      Experimental
  Current server: Mac Studio

  This server can delegate to
    Windows VM      Armed for agents
    Ubuntu VM       Manual only

  May delegate to this server
    MacBook         Authorized
```

The existing relay mux and per-source runtime work are useful for observing
and authenticating the browser's saved hosts. They do not establish
server-to-server trust. Settings may retain the developer toggle and later
hold advanced policy or diagnostics if those needs become concrete, but host
discovery, switching, pairing, arming, and revocation should be iterated in
this product surface.

If the experiment matures, the host surface may become the normal Switch Host
destination and the delegation section may become discoverable while remaining
collapsed. Discoverability does not authorize behavior: pairing and arming
remain explicit user actions.

## How YA Hosts Know About One Another

There is no required global host account, complete mesh, or automatically
replicated topology. Each YA server maintains only the peers and grants that
are adjacent to it:

- an outgoing relationship records a known worker and the authority this
  server has been granted there;
- an incoming relationship records a known controller and the authority this
  server has granted it; and
- host identity is distinct from the relay username, URL, or other route used
  to reach it.

A common VM testbed will naturally form a star: a Mac lab host may delegate to
Windows, Linux, and macOS guests, while each guest knows only that the Mac is
an authorized controller. A host may be a controller in one relationship and
a worker in another. Trust is directional and non-transitive; authorization
from Mac to Windows and Windows to Linux does not silently authorize Mac to
Linux.

The browser can help two servers establish a relationship because it may
already have an authenticated SRP resume session for both. A pairing flow may
select a saved host or ask the user to sign in through SRP, then use that
authenticated user presence to arrange a separate server-to-server grant. The
browser's password or saved resume secret should not become the server's
long-lived peer credential, and the browser should not remain the runtime
bridge after pairing.

Grants should be explicit, inspectable, and revocable from the server that
enforces them. Likely scope includes which projects and providers may be used,
a permission ceiling, concurrency bounds, and which session-control actions
are permitted. Exact fields are not decided.

Pairing and arming are also distinct ideas. A paired host may be available only
for an explicit user-initiated delegation, or it may be **armed for agents** so
an agent can choose it through a delegation tool. Agent-initiated delegation is
novel behavior and remains explicit/default-off.

Incoming grants need not imply reverse connectivity. A worker can accurately
show that a controller is authorized and when it last delegated without
claiming the controller is currently online.

## Delegated Sessions

A delegated worker is a normal YA session owned and supervised by the target
YA server. Its provider runs locally on that host. The controlling session and
worker session have separate YA ids and separate provider transcripts.

The relationship should be visible enough that the user can answer:

- which controlling session requested the work;
- which YA host and provider are running it;
- whether it is starting, active, waiting, complete, failed, or unavailable;
- where to open the worker's full native transcript; and
- what result was returned to the controller.

The controller may receive a structured result or bounded summary, but YA does
not silently merge the transcripts or present delegation as a super-session
jump. Provider-native subagents inside the worker remain a separate, nested
provider concept.

## Delegation And Local Control API Direction

The recent CSS refactoring campaign is useful evidence that YA already has
much of a provider-neutral control surface. The
[`monitor-agent-process.mjs`](../scripts/monitor-agent-process.mjs) helper and
the accompanying
[`Claude agent process runbook`](../docs/testing/claude-agent-process-runbook.md)
use the local YA API to create a bounded worker session, observe authoritative
process state, steer on an alert, read normalized output, and audit the result.
This demonstrated a practical form of one agent supervising another YA
session, even though the first campaign used one host and one provider.

That experiment is inspiration, not the delegation API contract. The monitor
is intentionally read-only, polling is only one possible observation method,
and the runbook contains campaign-specific policy that should not become a
general API by accident.

We have not decided:

- whether the reusable interface is primarily a CLI, library, MCP/tool server,
  skill-backed workflow, REST/stream client, or a combination;
- which object represents a delegated job versus its underlying YA session;
- the exact create, wait, result, message, steer, interrupt, abort, and cleanup
  vocabulary;
- how an agent discovers its own controlling session and avoids accidentally
  managing itself;
- how remote progress and attention should be delivered without chatty
  polling; or
- how much of the interface belongs in YA's existing public API versus a
  narrower delegation capability.

The desired design pressure is to avoid inventing unrelated local and remote
control models. Starting and supervising a session on the current YA server
and doing so through an authorized peer should share concepts where their
semantics are truly the same. Transport, authentication, grant enforcement,
and failure modes will still differ. The
[core service API](core-service-api.md) remains the adjacent proposal for
making YA's local provider/session runtime deliberately controllable.

An eventual agent skill can teach agents how and when to use this surface, but
the skill should sit above deterministic YA operations rather than carry peer
credentials or define the distributed protocol itself.

## Relationship To Existing Directions

**Relay monitor and mux.** The browser multi-host work proves independent
relay-backed sources can coexist and supplies the initial manual-host product
surface. It is not peer membership or delegation authorization.

**Remote Executors.** SSH Remote Executors keep one YA server authoritative,
are Claude-specific, and assume an SSH/rsync environment. Cross-host delegation
is a likely successor for new native-host work, but existing executor-backed
sessions may still need their historical resume behavior. Retirement is a
separate compatibility decision.

**Federated super sessions.** Delegation can prove server identity, directed
pairing, capability discovery, project mapping, remote start, and supervision.
A later jump may reuse those foundations, but it additionally requires provider
bundle portability, ownership transfer, terminal source behavior, target
resume, and client rebinding. Delegation must be useful even if jumping remains
provider-specific or deferred.

**Computer use.** Delegation initially benefits from whatever native tools the
target provider already supplies. A broader guest-native computer-use tool is
complementary and not a prerequisite.

## Open Questions

- Which existing installation identity, if any, should become the stable peer
  identity shown across browser and server records?
- What is the smallest pairing and revocation experience that remains clear
  when one or both hosts are temporarily offline?
- How are logical projects selected and mapped without allowing a controller
  to invent arbitrary target paths?
- What status should the host surface show from relay presence, browser SRP
  authentication, outgoing peer authorization, and last-seen inbound use?
- Which grant scopes are necessary for the first real delegation experiment?
- What is the right common seam between local agent orchestration and remote
  delegation?
- How should a controlling session display several concurrent workers without
  conflating them with provider-native child sessions?
- When does the YA-host path cover enough real use to begin retiring Remote
  Executors?
