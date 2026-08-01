# Interactives Architectural Review

> Maintainer review: the novice/kids creative-app motivation is good, but
> turning YA into a host for executable agent-built applications is outside
> its current core and creates a substantially different security and
> operations product.

Topic: interactives-architectural-review

Status: **architectural review (2026-08-01).** This records scope and security
concerns; it does not reject future experimentation through a separate,
explicitly enabled companion.

## Assessment

Public session sharing is a strong YA feature: a trusted YA viewer presents
read-only session data through a revocable link. The natural-looking
progression is:

1. share a session;
2. share its files and rendered artifacts;
3. render sanitized/static HTML; then
4. execute agent-authored JavaScript and perhaps attach a live service.

Step 4 is not an incremental viewer feature. On a YA application origin, the
browser gives that code the operator's web authority. API authentication does
not contain it: the browser attaches an HttpOnly session cookie to same-origin
requests, and same-origin JavaScript can set YA's mutation header. CSP and XSS
sanitization protect the trusted YA application; they do not make arbitrary
same-origin applications trustworthy.

The audience makes warnings insufficient. A novice prompter—and especially a
child—cannot be expected to audit generated dependencies, authentication,
secrets, network access, storage, or server endpoints. Safe behavior must be
structural and fail closed.

The transport requirement is a second, independent boundary. YA's shared relay
exists for lightweight session supervision and bounded supporting media such as
screenshots. Carrying arbitrary application assets, requests, streaming
responses, and WebSockets would turn it into a general-purpose ingress and
tunneling service. End-to-end encryption is important for session privacy, but
it also means the relay operator cannot meaningfully classify the application
traffic it is being asked to carry.

A production-quality version of that service needs the machinery expected of
an ngrok-like product: generic HTTP and WebSocket forwarding, tenant and app
isolation, admission capabilities, connection and bandwidth quotas,
backpressure, idle bounds, and abuse handling. Normal browser URLs add
per-application host routing, DNS, and HTTPS certificate management. Keeping
the app inside the YA client avoids some public-ingress mechanics, but then YA
must tunnel or emulate enough HTTP, navigation, asset, and WebSocket behavior
to run ordinary apps. Requiring special templates instead makes YA the owner of
a novel application runtime. Neither shape is a small extension to the relay.

Private ownership does not create a shared-service obligation. An operator may
choose to spend their own relay or tunnel capacity on arbitrary applications;
that does not make the generally available YA relay an appropriate default
transport for them. The shared relay's resource, availability, and abuse
contracts must not expand implicitly because an Interactive happens to be
associated with a YA session.

## Direction

Keep YA focused on agent sessions, project context, and safe artifact viewing.
Do not make same-origin executable Interactives a core feature.

Do not add generic application HTTP/WebSocket proxying to YA's shared relay, or
make YA responsible for application templates, backend provisioning, and
process lifecycle as consequences of artifact viewing. Projects that need a
live backend can expose it with a purpose-built facility such as Tailscale,
Cloudflare Tunnel, or ngrok. A narrow YA integration may remember and open an
explicit externally supplied project URL; it does not launch, authenticate,
proxy, or transport that service.

A bounded static experiment is a separate decision from backend hosting. YA
could eventually present a self-contained artifact in a rigorously isolated,
opaque-origin sandbox without promising general networking, storage, workers,
new-tab URLs, or server processes. That possibility must not be used as an
incremental path to arbitrary application tunneling.

A future experiment should be an optional companion server/app or desktop
mode with a separate untrusted-content origin. YA may provide a trusted,
project-scoped chat panel or narrow message bridge, but generated app code
must receive neither YA credentials nor general API authority. If this grows
into novice-friendly app building, hosting, lifecycle, and sharing, treat it
as a separate product even when it reuses YA components. Such a companion can
be independently enabled and operated by someone willing to own its traffic,
DNS, certificates, quotas, and abuse surface; it must not imply support from
the shared YA relay.

See [`active-content-security.md`](active-content-security.md) for the full
route audit and isolation contract.
