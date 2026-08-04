# Cross-Host Delegation

> Cross-host delegation lets an agent or user on one YA server start and
> supervise a separate, native YA session on another authorized YA server,
> without moving the controlling session or pretending the two transcripts are
> one conversation.

Topic: cross-host-delegation

Status: product direction with a provisional API shape. The user need, trust
shape, broad UI direction, provider-neutral coordination boundary, and agent
exposure model are clear enough to guide experiments. Peer identity, pairing,
grant fields, project mapping, exact wire schemas, and the worker-session
presentation remain intentionally open.

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

One YA server is commonly viewed through more than one access path: locally
from the machine itself and through the relay from another device. Delegation
is server-owned, so those views must agree. The route or browser origin used to
reach a server must not create a second apparent host identity or a different
grant topology.

The first UI slice therefore uses a dedicated experimental YA Hosts route
rather than changing the existing host switcher:

- the local client exposes `/-/hosts` and the relay client exposes the same
  page inside the current host route, such as `/:relayUsername/-/hosts`;
- both render one shared component representing the currently connected YA
  server;
- the page is linked only from an opt-in control in Developer settings;
- while that option is off, direct navigation to either local or relay form
  redirects to the current host's Projects page without rendering the preview;
- when enabled, the Open action stays inside that setting's card rather than
  appearing as a separate option;
- the sidebar **Switch Host** action disconnects the current source and performs
  a cache-busted document load of the host picker, so an installed web app both
  changes hosts and refreshes its client bundle at that already-destructive
  boundary. An updated service worker claims already-open older clients without
  navigating them, and treats the next host-picker navigation as a network
  reload even when that old client's Switch Host action predates the cache-bust
  parameter. The host picker and `/-/monitor` otherwise retain their existing
  behavior; and
- browser-saved hosts do not appear on the new page because they are
  browser-origin state rather than server-owned delegation state.

The initial page is intentionally a non-functional preview. It identifies the
current server without naming its access path, shows the two directional grant
sections, and renders explicit unavailable states. It does not call an
unreleased delegation endpoint, pair hosts, create grants, or imply that an
empty server response was observed.

The eventual server-scoped surface may look like:

```text
YA Hosts                                        Experimental
  Current server: Mac Studio

  This server can delegate to
    Windows VM      Armed for agents
    Ubuntu VM       Manual only

  May delegate to this server
    MacBook         Authorized
```

The existing relay mux and per-source runtime work remain useful for observing
and authenticating the browser's saved hosts, but they do not establish
server-to-server trust. Whether the server-scoped YA Hosts page and the
browser-scoped switcher eventually converge is deliberately deferred. Any
future convergence must preserve the distinction between browser connection
records and server delegation grants. Discoverability does not authorize
behavior: pairing and arming remain explicit user actions.

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

The relay is the default transport and design center. A controller must be able
to reach a worker through an encrypted relay circuit with no direct addressing
or network configuration, just as an authenticated client reaches a YA server.
The relay remains an opaque forwarder and does not become the peer registry,
authorization service, or plaintext API proxy. Pairing establishes a distinct
peer-scoped authorization and resumable secure session (using the existing
SRP/resume family or a closely related grant flow), separate from the browser's
saved SRP session.

This is relay-first, not relay-only. A future installation may prefer an
explicitly configured direct LAN or Tailscale path, but that is an optional
transport choice or optimization. It must preserve the same peer identity,
grants, encryption/authentication expectations, coordination semantics, and
failure model. No required delegation feature may depend on direct host
reachability, and adding a direct route must not create a second trust
relationship for the same peer.

Grants should be explicit, inspectable, and revocable from the server that
enforces them. Likely scope includes which projects and providers may be used,
a permission ceiling, concurrency bounds, and which session-control actions
are permitted. Exact fields are not decided.

Effective authority can only narrow as a request crosses layers: it is the
intersection of the agent/session enablement, the controller's outgoing grant,
the worker's incoming grant and local policy, and the target provider's actual
capabilities. A controller cannot request its way around a target-side ceiling.

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

## Provisional Coordination API Direction

The provisional direction is one **provider-neutral YA coordination service**,
not separate local-control and remote-delegation products. Starting and
supervising a session on the current YA server and doing so through an
authorized peer should use the same normalized operations where their
semantics are truly the same:

```text
Claude adapter ----\
Codex adapter ------+--> YA coordination service --> local YA runtime
REST/CLI client ----/                         \-----> authorized YA peer
```

This is a product boundary rather than a frozen route or schema. The exact URL
namespace, field names, and streaming transport will be decided by an
implementation proposal and compatibility review.

### A target-aware boundary, not an arbitrary REST proxy

The existing `/api/*` routes continue to mean resources owned by the YA server
receiving the request. Delegation should not be implemented by adding a
`?host=` query parameter to every existing route or by granting a controller
an arbitrary remote REST proxy. That would blur local resource ownership,
expand the delegated authority unnecessarily, and mix peer transport failures
with ordinary project/session errors.

Instead, a focused coordination namespace or service accepts an explicit
target at the operation boundary. The conceptual selector is:

```ts
type CoordinationTarget =
  | { kind: "local" }
  | { kind: "peer"; peerId: string };
```

`peerId` is a stable YA server identity, never a display name, relay username,
URL, or browser-saved route. A create request uses an opaque target-local
project reference selected from the projects that the worker grant allows the
controller to inspect. A controller does not send an arbitrary target
filesystem path, and the first implementation does not require YA to maintain
one canonical cross-host project mapping.

YA should expose enough read-only project facts for the controlling agent or
user to resolve the target before creating work. Useful evidence includes the
project name, target-local path and project id, Git root/history-root commits,
normalized remotes when present, current branch and HEAD, dirty state, and
whether several clones or worktrees are candidates. A shared root commit plus
project name is a strong hint that two checkouts share history, but not a
unique identity: forks, clones, and worktrees share roots, shallow clones may
not contain one, and rewritten/imported histories may differ.

YA reports this evidence and performs mechanical preflight; it does not decide
the repository semantics for the agent. The agent may select an unambiguous
candidate, request more inspection, ask the user, or deliberately prepare a
different checkout. If candidates remain ambiguous or requested expectations
such as branch, commit, or cleanliness do not hold, the operation should fail
with structured facts rather than silently guess or mutate the checkout. A
remembered user-approved mapping may later make repeated use convenient, but
it is not the only valid resolution mechanism.

The initial operation vocabulary should cover:

- list authorized targets and their relevant capabilities;
- describe the supported coordination operations and schemas;
- inspect authorized target-project candidates and readiness facts;
- create a normal YA session on a selected target;
- observe status, progress, messages, attention, and bounded results;
- wait for a meaningful state transition without chatty polling;
- send a message, steer, or answer requested input where the provider/session
  state permits it; and
- interrupt, abort, and release supervision resources deterministically.

Creating remote work returns a durable **delegation handle** which records the
controller, worker peer, worker YA session, authorization context, and current
state. Later operations address that handle rather than repeatedly passing a
host selector. The worker session remains a normal target-owned YA session
with its own YA id and provider transcript; the delegation handle is the
controller's supervision relationship, not a replacement public session id.

The local target should traverse the same coordination application service as
the peer target. Authentication, grant enforcement, transport, and remote
failure handling remain peer-only layers, but normalized session-control
semantics should not fork merely because the target is local.

### One API, several agent and human adapters

The coordination service is the product. REST, a CLI, provider-native tools,
MCP, and eventual skills are adapters over it; they must not independently
implement orchestration policy or define incompatible operation vocabularies.
Direct clients should be able to use the full supported coordination surface
without an agent harness.

Claude and Codex are both first-class consumers. The shared capability cannot
depend on a Codex-only tool lifecycle, nor should Claude receive a reduced
control model. Each provider adapter may attach and discover tools differently,
but it exposes equivalent YA operations and reports provider-specific
capability gaps honestly. Other providers can adopt the same adapter contract
later.

The initial agent-facing surface should stay small and searchable rather than
expose dozens of raw REST routes. A likely shape is a few structured operations
covering targets, start, observe/wait, and control. Whether those are four MCP
tools, a slightly different grouping, or native provider tools remains open;
their underlying coordination requests and results do not.

### Discovery without standing context injection

Tool discovery and target discovery are separate:

1. The user explicitly enables YA coordination for the session or applicable
   agent policy. When disabled, YA adds no tools, prompt text, or autonomous
   delegation behavior.
2. The enabled provider adapter exposes compact searchable tool metadata.
3. The agent asks YA for currently authorized and armed targets when it needs
   them. Host topology, credentials, and grant secrets are never copied into
   the provider prompt.

For provider-attached tools, YA binds the controlling YA session and acting
user/server authority when it creates the adapter. The model does not establish
that authority by supplying a session id, prompt token, environment variable,
or peer credential. An operation may echo the bound controller identity for
audit and self-delegation checks, but it cannot use a model-chosen identity to
impersonate another session. Direct REST/CLI clients use their authenticated
caller identity instead.

The normal path should rely on structured tool discovery. YA may optionally
add one short capability hint when the user enables the feature, using the same
broad product pattern as other explicit agent-context hints, but it should not
inject a standing host list or API tutorial. A skill may teach higher-level
workflow and judgment, but it is optional guidance above deterministic tools,
not the source of authority, peer credentials, or protocol semantics.

Lazy tool-definition loading is an optimization available in current Claude
and Codex integrations, not a cross-provider correctness requirement. The
surface should remain compact enough to be acceptable when a provider loads
its definitions eagerly. Enabling tools in an already-running provider session
may also have provider-specific lifecycle constraints; initial implementation
may attach the adapter at session launch while preserving the same API.

### Inspectable without a source checkout

The CSS refactoring campaign is useful evidence that YA already has much of a
provider-neutral control surface. The
[`monitor-agent-process.mjs`](../scripts/monitor-agent-process.mjs) helper and
the accompanying
[`Claude agent process runbook`](../docs/testing/claude-agent-process-runbook.md)
use the local YA API to create a bounded worker session, observe authoritative
process state, steer on an alert, read normalized output, and audit the result.
That demonstrated a practical form of one agent supervising another YA
session, even though the first campaign used one host and one provider.

That experiment was especially usable because an agent in the YA source tree
could inspect route implementations and surrounding examples. A supported
external coordination API must preserve that discoverability for an agent that
does not have the YA repository. It should provide machine-readable operation
schemas, capability descriptions, stable structured errors, and concise
examples through an OpenAPI-like document, a `describe` operation, generated
CLI help, or an equivalent mechanism. The exact documentation format remains
open; source-code access must not be required.

The experiment remains inspiration, not the delegation API contract. The
monitor is intentionally read-only, polling is only one possible observation
method, and the runbook contains campaign-specific policy that should not
become a general API by accident.

The [core service API](core-service-api.md) remains the adjacent proposal for
making YA's local provider/session runtime deliberately controllable. The
coordination service may reuse that runtime seam, but cross-host grants and
delegation records remain a higher-level product boundary.

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

## Known Open Questions

This is the explicit decision backlog, not a reopening of the settled baseline.
The relay is the required zero-configuration/default transport, while optional
direct LAN or Tailscale routes may carry the same peer protocol later.
Likewise, YA supplies target project discovery, mechanical facts, assertions,
and structured blockers; the agent or user owns branch, checkpoint,
cleanliness, worktree, and other repository semantics.

Before a first working delegation slice, an implementation proposal must
resolve at least:

1. stable peer identity plus the peer-scoped SRP/grant/resume record;
2. the minimum incoming/outgoing grant scopes and revocation behavior;
3. the target-project fact schema, opaque project reference, and preflight;
4. the delegation state machine, idempotency, ownership, and cleanup rules;
5. observation/wait, reconnect/catch-up, result, and error semantics; and
6. equivalent Claude and Codex tool schemas plus their attachment lifecycle.

The remaining questions below may be answered incrementally where the first
experiment does not depend on them.

### Identity, connectivity, and grants

- Which existing installation identity, if any, should become the stable peer
  identity shown across browser and server records, and how are its keys
  rotated or recovered?
- What is the smallest pairing and revocation experience that remains clear
  when one or both hosts are temporarily offline?
- What exact peer-scoped SRP/grant record is established during pairing, how is
  its resumable relay session stored and expired, and which side owns reconnect
  while delegated work is active?
- When an optional direct LAN or Tailscale route is configured, what route
  preference and failover policy preserves one peer identity and one resumable
  delegation rather than creating transport-specific relationships?
- Does revoking a grant block only new work, also block further control of
  existing workers, or abort active workers under an explicit policy?
- Which grant scopes, concurrency/resource budgets, and audit facts are
  necessary for the first real delegation experiment?
- What status should the host surface show from relay presence, browser SRP
  authentication, outgoing peer authorization, and last-seen inbound use?

### Project and launch policy

- What is the minimum normalized project/repository fact schema, and when does
  an explicit user choice become a remembered convenience mapping?
- Which launch fields may a controller choose—provider, model, effort,
  permission mode, environment/tool profile, initial prompt, and attachments—
  and which are selected or capped by the target?
- Which branch/commit/cleanliness expectations can an agent ask YA to verify
  mechanically, and how are artifacts returned when checkouts differ?
- At what scope is agent coordination enabled: server, project, session,
  provider launch, or some layered combination?

### Delegation lifecycle and observation

- What is the exact delegation-record lifecycle, retention period, idempotency
  key, and cleanup behavior after completion, controller loss, or worker
  restart?
- What exactly marks successful completion and distinguishes a bounded result,
  a transcript excerpt, an approval/input request, and an incomplete but idle
  worker?
- Which observation transport supplies state transitions and bounded output,
  and what reconnect/catch-up guarantees does it provide?
- Which normalized errors distinguish authorization, target reachability,
  target capability, project mapping, provider failure, and stale delegation
  state?
- Which protocol/capability version gates the coordination namespace and peer
  operations across mixed YA releases?

### Agent and user experience

- How does an agent reliably identify its controlling YA session and avoid
  recursively delegating to itself or forming an unintended delegation loop?
- How should a controlling session display several concurrent workers without
  conflating them with provider-native child sessions?
- How does a user open the native worker transcript when the browser is not
  already authenticated to or aware of the worker peer?
- Which worker attention states trigger controller messages, UI attention, or
  notifications, and who is allowed to answer them?
- Which small agent-facing tool grouping is clearest across both Claude and
  Codex, and which provider versions can attach it after session launch?
- What is the fallback when coordination is enabled after a provider session
  has started but that provider cannot attach tools dynamically?
- When does the YA-host path cover enough real use to begin retiring Remote
  Executors?
