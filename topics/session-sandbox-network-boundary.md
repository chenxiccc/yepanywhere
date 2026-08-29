# Session Sandbox Network Boundary

> The session sandbox network boundary is an optional, creation-time firewall
> for project-write sessions that preserves public Internet egress while
> denying direct access to the YA host, local networks, and private YA/provider
> control sockets.

Topic: session-sandbox-network-boundary

Status: **Implemented for local Linux Claude-family and Codex sessions.** The
authoritative availability and launch probes require Bubblewrap,
`slirp4netns`, `unshare`, and `ip` to establish the complete boundary.

See also:

- [session-sandboxing](session-sandboxing.md) — filesystem policy, supported
  providers, private state, and session lifetime;
- [session-defaults](session-defaults.md) — all-provider defaults that seed New
  Session;
- [security](security.md) — YA authentication and public-relay boundaries; and
- [provider-host-api](provider-host-api.md) — the private local provider
  control plane that must not be exposed to a sandboxed agent.

## Product Contract

New Session exposes **Network firewall** immediately after **Project writes
only**. Settings > Session Defaults exposes the same control as a standing
default for newly created sessions. The firewall control is enabled and sent
only when **Project writes only** is selected; unsandboxed sessions retain
their existing networking with no helper processes or network setup.

Selecting **Project writes only** also selects **Network firewall**. A user may
then turn the firewall off for a provider or tool that needs host-local access.
Turning the project sandbox off and on selects the firewall again. This is a
security correction inside an already explicit sandbox opt-in, not a new
default for ordinary sessions.

The control's caption must state the consequence rather than imply that the
filesystem boundary is sufficient:

> Blocks the YA server and other host-local services. Without the firewall, a
> sandboxed agent may easily access YA and escape the sandbox.

The session choice is settled before provider launch and inherited by resume,
restart, transcript fork, recap fork, retitle fork, and Project Queue launch in
the same way as the sandbox level. It is not a live-session toggle.

The persisted and request field is additive:

```ts
interface NewSessionDefaults {
  sandboxLevel?: SessionSandboxLevel;
  sandboxNetworkFirewall?: boolean;
}
```

An absent firewall value resolves to enabled when the effective sandbox level
is `project-write`, including an older client creating a session on a corrected
server and a legacy sandboxed session being relaunched. It resolves to disabled
for `none`. Explicit `false` is preserved. A true firewall value without
`project-write` is invalid at the server boundary.

## Network Enforcement

An enabled firewall uses a separate Linux network namespace. The provider and
all descendants see their own loopback interface, so `127.0.0.1`, `::1`, and
abstract Unix-domain sockets cannot name host services.

Public IPv4 egress is supplied by a session-owned `slirp4netns` process. Before
provider code runs, a trusted namespace setup stage installs non-removable
prohibit routes for loopback, private, carrier-grade NAT, link-local,
documentation/benchmark, multicast, reserved, and every concrete IPv4 address
assigned to the host. A dedicated slirp DNS endpoint remains reachable. DNS
rebinding to a prohibited address is therefore rejected after resolution, not
trusted because the original name looked public. IPv6 egress is disabled in
the first version rather than left as an unfiltered second path.

The provider process starts only after slirp reports ready and all prohibit
routes are installed. Bubblewrap then drops the complete capability set and
sets no-new-privileges before provider code executes, so the agent cannot
remove routes, join the host namespace, or widen the network. Setup failure
terminates the namespace and helper and fails the session launch closed.

This policy is destination-based rather than a port denylist. It blocks YA,
SSH, databases, container daemons exposed over TCP, local proxies, notebook and
debug servers, and future host listeners without needing to recognize their
ports. Public endpoints remain reachable, including the YA public relay; the
existing rule still applies that project-readable operator credentials can be
used against remote APIs and are outside this filesystem-integrity boundary.

Host-local Claude Gateway or Ollama endpoints are intentionally blocked. A
user who needs one must turn the firewall off and accept the captioned escape
risk; the implementation does not create a privileged per-port exception that
could become another process launderer.

## Private IPC Enforcement

The existing private `/run`, `/tmp`, and `/var/tmp` mounts hide the normal
system/user D-Bus, SSH agent, Docker/Podman, display-server, IDE, and provider
socket locations. The launch policy also unsets broker/control environment
variables and masks an explicitly configured
`YEP_PROVIDER_RUNTIME_DIR` or `YEP_PROVIDER_HOST_RUNTIME_DIR` when it lies
outside those private roots.

The explicit provider-host runtime directory must be a dedicated directory
outside the selected project and its private provider state. An overlapping or
over-broad configuration fails a firewalled launch rather than leaving the
control socket/token visible or hiding the project/home tree unpredictably.
Placing a privileged host socket inside the writable project is an explicit
operator-created delegation and is not made safe by this policy.

## Compatibility Contract

The permanent `session-sandbox-network-firewall` capability owns:

- `settings.newSessionDefaults.sandboxNetworkFirewall`;
- the additive session-create, start, restart, and Project Queue request field;
- persisted session metadata and derivative inheritance; and
- `sandboxEnforcement.networkFirewall` in launch/process responses.

The optional-feature release corpus is `v0.7.0` (2026-07-25) and `v0.6.2`
(2026-07-11). Both lack session sandboxing and the firewall field. A current
client requires the new capability together with the existing dynamic
`session-sandboxing` capability and available host status before showing any
sandbox controls. Without it the client hides the controls and sends neither
sandbox field. Existing clients omit the new field; a corrected server applies
the secure project-write default described above. Existing capability meanings
and older capable behavior are otherwise unchanged.

The host availability probe covers Bubblewrap, `unshare`, `slirp4netns`, and
the route utility plus a real namespace/egress setup. A partial installation is
not advertised as an available sandbox backend. The authoritative launch path
repeats the complete setup.

## Implementation

`prepareSessionSandbox` remains the single server-side policy owner. For an
enabled firewall it validates the trusted helper set, creates the private DNS
configuration, masks provider-host control state, probes the completed
namespace, and returns a spawn wrapper around
`session-sandbox-network-launcher.mjs`. The launcher owns namespace setup,
slirp readiness, route installation, signal forwarding, exit propagation, and
helper teardown. Explicit firewall opt-out keeps the direct Bubblewrap path;
an unsandboxed launch creates no firewall helper.

`SessionMetadataService` stores the settled selection. `Supervisor` and
`SessionActivationCoordinator` compare the network selection as part of the
immutable session boundary. A retained provider runtime whose recorded
boundary differs is terminated and relaunched instead of being attached under
an inaccurate enforcement claim. Session create/start, Project Queue,
reactivation, restart, transcript fork, recap, retitle, and fork-summary paths
all preserve the same value.

The client requires `session-sandbox-network-firewall` in addition to the
existing sandbox protocol and available-host signals. New Session and Session
Defaults expose the same translated control and caption. Servers continue to
own validation and the secure missing-value default, so legacy clients cannot
accidentally create a project-write session with the old shared-network
boundary.

## Verification

Native Linux tests execute the production wrapper and verify project writes,
zero effective/permitted capabilities, no-new-privileges, public IPv4 routing
and DNS, denial of private and IPv6 routes, denial of loopback, the slirp host
alias, and the host's concrete IPv4 address, plus isolation of abstract sockets
and provider-host pathname control state. Separate tests cover trusted-helper
failure, auth credential removal, retained-runtime replacement, metadata and
derivative inheritance, parser rejection, explicit opt-out, older-server
capability fallback, live capability advertisement, and UI submission. A
production-wrapper smoke test also reached a public HTTPS endpoint while the
firewall was enabled.

Final browser captures at 1000×600 and 375×812 verify that the Session Defaults
controls remain grouped, checked state is unambiguous, explanatory text stays
with its control, and neither viewport overflows horizontally.

The ordinary server test command runs under a launcher-owned disposable home;
real SDK integration commands retain the operator home and their explicit
opt-in gates.

## Known Limits

- The first implementation permits public IPv4 only. IPv6 requires equivalent
  destination filtering before it can be enabled.
- Remote public services can still mutate data when the sandbox can read a
  usable credential. In particular, the firewall is not a credential-isolation
  or network-exfiltration boundary.
- Kernel, Bubblewrap, slirp, and route-tool vulnerabilities remain trusted.
- Concrete host IPv4 addresses are captured when the sandbox launches. Private
  ranges remain blocked, but a new publicly routed host address acquired by a
  long-lived session is not added until the next launch.
- Pathname Unix sockets outside private `/run`, `/tmp`, `/var/tmp`, and the
  masked provider-host runtime remain connectable when filesystem permissions
  allow it. Operators must not place privileged sockets elsewhere in the
  readable host tree, including inside the writable project.
