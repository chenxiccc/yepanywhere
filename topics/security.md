# Security

> Security is YA's trust-boundary contract: ordinary authenticated access has
> the power of a single server-account operator, while public shares and relay
> operators do not inherit that authority.

Topic: security

## Authority Model

YA is a single-user, self-hosted agent supervisor. It does not currently have
application-level user accounts, roles, project access-control lists, or an
authenticated read-only/operator split. A valid local password session, desktop
session, or Remote Access SRP session reaches the same operator-facing API.
When local authentication is disabled, anyone who can reach an admitted server
endpoint has that same authority without first presenting a credential.

The practical trust boundary is therefore **can use normal authenticated YA,
including creating or controlling an ordinary session**. That authority should
be treated as the authority of the operating-system account running YA. An
ordinary unsandboxed provider process can generally:

- read and modify anything that account can read or modify;
- run programs and use same-account services, sockets, credentials, and SSH
  access available to its process environment;
- inspect session history and send, steer, interrupt, or approve agent work;
  and
- change server settings or create another session with different provider
  permission choices.

This is intentional. Provider permission modes and approval prompts remain
useful safety controls, but they are not roles separating mutually distrusting
YA users. Run YA under a dedicated least-privilege OS account, VM, or container
when the serving account itself must be isolated from other host state.

A future restricted multiuser or delegated-guest layer requires new principals,
server-side authorization, and an enforced execution boundary. Hiding controls,
selecting a project working directory, or assigning a narrower-sounding
permission mode would not establish that boundary.

## File Access Is A Viewer Policy

Settings > Local Access > **File access** controls which directories YA's
authenticated HTTP file viewers may read through the local-file, local-media,
and absolute project-file routes. Its default omits the server account's home
directory, and path resolution prevents traversal or symlink escape from the
configured prefixes. This is defense in depth for the browser/API file doors.

It does **not** constrain provider tools, terminals, commands, source-code
processes, or an SSH-backed provider. Turning off **Home folder** therefore does
not prevent an authenticated operator from asking an ordinary agent to read a
home-directory file. Pinning `ALLOWED_FILE_PATHS` makes the viewer policy
read-only in Settings; it still does not create an agent sandbox. See
[`docs/tactical/018-file-access-scoping.md`](../docs/tactical/018-file-access-scoping.md).

The separate **Sandbox session / Project writes only** launch option is the
current host-enforced boundary. On supported local Linux Claude-family and
Codex sessions, Bubblewrap prevents ordinary persistent writes outside the
canonical project and YA-owned private state. It is default-off, permits reads
outside the project and network access, does not claim general hostile-code or
confidentiality isolation, and fails closed when requested but unavailable.
Unsupported providers, non-Linux hosts, and SSH executors cannot use it. Even
an enforced sandbox limits one provider process; it does not reduce the
authority of an authenticated operator who may create another unsandboxed
session. See [`session-sandboxing.md`](session-sandboxing.md).

Agent-authored active documents are therefore significant defense-in-depth
hardening—important, but not a new general trust boundary—specifically for a
provider process running inside that project-write sandbox. If the operator
opens such a document on YA's authenticated origin, its script can borrow the
operator browser's ambient YA authority and act outside the process's
filesystem confinement. For an ordinary unsandboxed local provider the borrowed
authority is not new: that provider already runs as the local server account.

An SSH-backed provider is different. It holds only the remote SSH account and
its selected session environment, but a document it authored, served from the
local YA origin, would act as the local YA operator—creating or controlling
local sessions, changing settings, and reaching the local server account.
Remote-authored active content served locally is therefore a cross-host
privilege escalation, and the scriptless response policy below is load-bearing
for SSH executors, not redundant hardening.

YA applies the cheap backstop everywhere: active HTML, XHTML, SVG, XML, and
XSLT file responses are downloads with `nosniff` and a scriptless response
policy across local, project, upload, and public-share routes. The classifier
uses only MIME type and extension; it does not scan or sanitize contents.
Additional precautionary sanitization that is computationally heavy is
reserved for enforced project-write sandbox sessions. See
[`active-content-security.md`](active-content-security.md).

## Authenticated Remote Access And The Relay

The Remote Access password is a full operator credential, not a limited remote
viewer password. Full login uses SRP-6a: the server stores verifier material,
the password is not sent over the connection, and the client verifies the
server's `M2` proof before accepting the derived key. Protocol-3 resume requires
a server proof under the saved base key bound to fresh client and server nonces;
the client also rejects a downgrade below the highest authenticated resume
protocol version it has seen.

Application frames then use per-connection keys with NaCl secretbox
(XSalsa20-Poly1305) authenticated encryption and sequence checks. The ordinary
relay forwards the resulting frames without receiving those keys. Relay mux
wraps several independently authenticated circuits in one physical WebSocket;
it does not share SRP or NaCl state between YA servers.

Given trusted client code and uncompromised client/server endpoints, a
malicious relay operator cannot passively read Remote Access application
contents or uploads, learn the password or session key, silently impersonate
the YA server after login/resume, or alter encrypted contents without
detection. The relay can still:

- observe endpoint addresses, relay usernames, channels/circuit grouping,
  server presence and advertised compatibility metadata, connection timing,
  and frame sizes;
- correlate hosts grouped on one mux connection and perform traffic analysis;
  and
- delay, drop, replay, reorder, or corrupt traffic, causing detectable failure
  or denial of service.

Remote Access is therefore content-private from the relay operator, not
anonymous, metadata-private, or availability-protected. This claim does not
cover public shares, which deliberately use a different plaintext relay path.

The client is part of the trust root. Malicious JavaScript served by a hosted
client origin, a privileged browser extension, or a compromised packaged app
can steal a password or cached resume secret before transport encryption helps.
Use signed/bundled or locally served client assets when the threat model
includes compromise of both the relay and live hosted client delivery; see
[`trusted-client-packaging.md`](trusted-client-packaging.md).

## Multiple YA Servers And Orchestration

The implemented multi-host monitor and relay mux do not create server-to-server
trust. Each YA server retains an independent login, resume secret, encryption
key, source runtime, and failure lifecycle. A client compromise can still expose
every saved host credential available to that client, so adding hosts enlarges
the client's blast radius even though one host does not authorize another.

The proposed cross-host delegation service is a different boundary. Pairing a
server must create a distinct server-to-server principal rather than copy a
browser password, browser resume secret, or relay registration credential.
Grants remain explicit, directional, non-transitive, inspectable, revocable,
and default-off for agent use. The relay remains an encrypted transport rather
than a peer registry or plaintext API proxy, and a controller must not receive
an arbitrary proxy to the worker's authenticated `/api/*` surface.

Most importantly, an incoming grant that can create or control an ordinary
unsandboxed session effectively delegates the target YA server account's full
authority. A project allow-list chooses an initial target; it does not stop that
session from reading or writing elsewhere. Provider and permission ceilings are
useful policy controls, but they are not an OS boundary. A grant may be called
"bounded" only when every path it authorizes is enforced at the target and its
remaining outside-read, network, IPC, credential, and privilege surface is
stated. Compromise of an armed controller must otherwise be modeled as
compromise of the worker's server account.

Federated super-session peers require an even stronger explicit trust decision.
They exchange sensitive transcript/provider bundles and transfer the right to
resume a session as the target account. The current proposal therefore calls
them mutually trusted peers; transport encryption and single-writer ownership
do not turn them into mutually untrusted tenants.

## SSH Remote Executors

Configured Remote Executors are aliases in the YA server account's
`~/.ssh/config`. YA launches the remote Claude-family provider through the
system SSH client with `BatchMode=yes`, runs it as the selected remote SSH
account, and synchronizes Claude session files with `rsync`. A home-relative
local project path is mapped to the remote account's home; that mapping selects
a working directory and is not confinement.

An SSH-backed agent has the authority of the remote SSH account, subject only
to controls enforced on that remote host. Local **File access** settings do not
restrict it, and the current **Project writes only** sandbox is rejected for
remote executors because confining the local SSH client would not confine the
remote provider. YA may also forward a locally supplied `ANTHROPIC_API_KEY` to
the remote Claude launch. The remote host and account must therefore be trusted
with provider prompts, command/output contents, synchronized transcripts, and
any credentials deliberately made available to that launch.

Removing an alias from YA Settings removes the product entry point; it does not
revoke an SSH key, agent socket, remote `authorized_keys` entry, or other
host-level access. Restrict or revoke those at the SSH/OS boundary. A future
remote sandbox claim must be installed and attested by the remote execution
host before provider-controlled code runs.

## Desktop Loopback

The desktop loopback dashboard is authenticated local content, but a random
port or a localhost origin is not identity. The native shell must not expose a
long-lived desktop credential to renderer JavaScript.

Desktop v0 uses a private native/server startup secret to mint a short-lived,
single-use navigation code. Consuming that code establishes a host-only,
HttpOnly, SameSite=Strict session cookie. Bootstrap credentials and routes are
accepted only on the loopback listener, never optional LAN, relay, or
internally forwarded surfaces. Reload uses the cookie and must not require a
token in the URL, JavaScript module state, request header, or WebSocket query.

The implementation bounds bootstrap state to 16 codes with a 30-second
lifetime, 30 invalid attempts per minute, and 32 in-memory desktop sessions
with a 30-day server-side lifetime. State dies with the bundled server and is
never persisted. Because v0 serves plain loopback HTTP, its host-only cookie
cannot use `Secure`; it remains HttpOnly, SameSite=Strict, and path-rooted.

The loopback dashboard is a remote origin from Tauri's perspective and receives
no custom native-command capability. Packaged Tauri-origin diagnostic surfaces
receive narrowly scoped commands. See [`desktop-v0.md`](desktop-v0.md) for the
distribution, compatibility, lifecycle, and same-user-process threat model.

The signed macOS runtime grants `com.apple.security.cs.allow-jit` to Tauri's
executable signing targets because the bundled Bun/JavaScriptCore sidecar
cannot expose the JavaScript runtime required by the server under hardened
runtime without it. Tauri's shared signing configuration also puts the
entitlement on the native shell; it does not grant it to remote dashboard
content running in WKWebView. The release must not add the broader
unsigned-executable-memory, executable-page-protection, or
disable-library-validation exceptions.

## Public Read-Only Shares

Public shares are the deliberate exception to ordinary authenticated operator
access. They are default-off, unauthenticated bearer-link views: possession of
the full secret URL authorizes the selected live or frozen transcript and its
share-scoped file resources until the link is revoked. They do not authorize
session creation, messages, approvals, settings, source control, or the normal
authenticated file APIs. A per-tab viewer token is not identity and does not
prevent a bearer from reopening the URL.

This smaller authority still carries material disclosure risk. Shared
transcripts may already contain source code, secrets, file snippets, command
output, or crash logs. Live shares reveal later eligible content, and some
frozen shares must warn that linked files remain live when the filesystem cannot
provide the requested copy-on-write snapshot. Owners must review the content
and treat the bearer URL itself as a secret.

## Public Share File Access

Public read-only shares may open project files through a share-scoped public
route when the requested path is visible from the shared session content. The
viewer must not navigate into `/api/local-file`, `/api/local-image`, or
`/projects/.../file` directly, because those routes are authenticated/local app
surfaces and cause public viewers to fall into Remote Access login.

See [`attachment-storage`](attachment-storage.md) for the current legacy
project-relative `.attachments/` path and the app-data-only target. Physical
attachment location does not broaden these `/api/local-image` and
`/api/local-file` routes or constitute public authorization.

The current lightweight route serves project files whose relative or
project-root-absolute path is present in the shared transcript. Public clients
rewrite rendered local/project file links to `/share/:secret/file`, which fetches
`/public-api/shares/:secret/files` through the same relay and secret used for
the public session body. For rendered Markdown/HTML documents that are already
visible from the transcript, the route may also serve bounded local media assets
referenced by that document so public preview images do not fall through to
login-gated local routes.

Public authorization follows captured share-visible links; it is not a general
filesystem discovery facility:

- A frozen revision attempts a whole-project copy-on-write clone only when the
  actual project/app-data filesystem pair supports it. The clone is private
  app-data storage and does not authorize its unlinked contents. Authorized
  frozen file views resolve from the clone, so later source changes do not
  change those bytes.
- When CoW cloning is unsupported, retain the current behavior of resolving an
  authorized frozen link against the live project rather than making an
  unbounded physical worktree copy. Both the owner creation flow and public
  frozen viewer must persistently warn that linked files remain live and may
  expose later contents. An unexpected clone failure aborts creation instead
  of silently downgrading to that mode.
- A live share may refresh its allowed paths only from transcript-visible links
  or other deliberate share content, not from arbitrary project paths supplied
  by the public viewer. A frozen share may replay path-existence link decisions
  that were already known when captured, but it never answers new existence
  queries.
- The current transitive render-asset allowance is computed live from the
  referenced Markdown/HTML source. A CoW-backed frozen view resolves it within
  that frozen tree; a live-file fallback carries the same warning.
- Public endpoints should use captured opaque targets or exact allowed entries,
  not raw absolute paths, `..` traversal, or symlink-sensitive filesystem
  resolution chosen by the browser.
- CoW project snapshots omit symlinks. A symlink can otherwise escape the
  immutable clone and expose later external bytes while the share reports that
  linked files are frozen.

The design point is intentionally narrower than "the user could ask the agent to
cat that file." That argument applies to the authenticated operator, not to an
unauthenticated public share recipient.

Until a captured allowed-path set exists, public-share viewers must not follow
local/authenticated file links into the normal app. A share-scoped relay request
is acceptable for transcript-visible project files; otherwise blocking the click
with an explicit notice is preferable to falling through to Remote Access login,
which incorrectly suggests the public viewer should authenticate to read a
secret-link snapshot.

## Public Share Transcript Secrets

Public-share link scoping does not redact transcript text. `Read` snippets,
`Edit` context, and command output such as `env`, `printenv`, stdout, stderr,
test logs, and crash dumps can already contain secrets by the time a share is
created or served. Providers usually avoid reading or repeating obvious secrets,
but rare misses are expected over enough turns, so public-share safety must not
depend on provider restraint.

Interim UI contract: public share viewers warn that visible assistant
read/edit/command output should be considered public, with stronger wording for
live shares. Longer-term design should add content-aware censorship before
public share bodies are sent to unauthenticated viewers; see
[`public-share-content-censorship.md`](public-share-content-censorship.md).

## Public Share Relay Privacy

Normal authenticated Remote Access is relay-mediated but end-to-end encrypted.
Public shares are different: current public-share relay requests carry the
share URL secret, request path, and response contents as plaintext relay
payloads. The relay transport still uses WSS to protect the browser-to-relay hop
from ordinary network observers, and the current relay forwards without logging
share payloads, but a relay operator who inspects frames can see public-share
contents and bearer secrets. The operator can also modify or replay those
plaintext requests and responses; WSS authenticates only the browser-to-relay
hop. Public shares should therefore be described as unguessable bearer-link
read-only views, not as relay-operator-private or end-to-end authenticated
views. See
[`topics/relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md).

## Review Contract

This topic states the intended security boundaries; it is not a certification
that every implementation path satisfies them. A security review should treat
an unexpected authority widening, public-to-authenticated route crossing,
relay plaintext leak, missing target-side enforcement, or misleading UI claim
as a finding. A future restricted multiuser layer must update this contract
before it can weaken the current assumption that ordinary login/session
creation means full server-account authority.

## Related Notes

- [`active-content-security.md`](active-content-security.md) records the
  confirmed same-origin active-document execution path, the source-first file
  contract, and the isolated-origin requirement for agent-built applications.
- [`docs/tactical/000-relay-origin-and-share-gating.md`](../docs/tactical/000-relay-origin-and-share-gating.md)
  records the current public-share relay, opt-in, and revocation decisions.
- [`public-share-content-censorship.md`](public-share-content-censorship.md)
  records the proposed content-aware redaction layer for public transcript
  output.
- [`session-sandboxing.md`](session-sandboxing.md) defines the implemented
  Linux project-write boundary and the additional admission work a
  future interactive “locked to this session” share would require.
- [`relay-client-mux.md`](relay-client-mux.md) keeps each host's authentication
  and encryption independent while sharing a physical relay connection.
- [`cross-host-delegation.md`](cross-host-delegation.md) and
  [`federated-super-sessions.md`](federated-super-sessions.md) record the
  proposed server-to-server trust and orchestration shapes.
- [`docs/project/remote-executors.md`](../docs/project/remote-executors.md)
  records the current SSH executor behavior and limitations.
- [`SECURITY.md`](../SECURITY.md) is the public security-policy entry point for
  reporting vulnerabilities and should stay operator-facing rather than carrying
  implementation-specific design contracts.
