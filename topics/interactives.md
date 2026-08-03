# Interactives

> Proposal: a zero-setup container for agent-built web apps — dev servers or
> static page bundles scaffolded from an opinionated template and registered
> in project-local config — that YA surfaces as persistent icon links on the
> project's sessions and reaches through its authenticated relay, while
> executing only on an isolated untrusted-content origin and optionally
> reusing globally configured Tailscale and Cloudflare access, so a user on a
> phone or tablet can open them with no hosting knowledge.

Topic: interactives

Status: **proposal, nothing implemented (2026-07-24).** YA's only proxy today
is the Vite dev-client proxy (`createFrontendProxy`,
`packages/server/src/frontend/proxy.ts`); no arbitrary-port proxying and no
project app registry exists. The rich annotator/interview flow originally
drafted here is split out to [[rich-interviews]] — different intent, different
lifecycle, no committed implementation overlap. The serving and security
direction was revised on 2026-08-01 after the confirmed same-origin execution
path in [[active-content-security]]; the former main-origin `/apps/...` shape
is no longer a valid implementation direction.

**Maintainer architectural review (2026-08-01):** the creative, novice-friendly
motivation is valuable, but executable application hosting is outside YA's
current core and same-origin execution is a security non-starter. Any future
experiment belongs behind a separately isolated, optional companion boundary.
See [`interactives-architectural-review.md`](interactives-architectural-review.md).

**Storage amendment (2026-08-03):** the proposal's `.yep/interactives.json`
registry is YA-managed state and is governed by
[Project Directory Storage](project-directory-storage.md). It lives centrally
by default and may be project-local only after the global opt-in. The user's
explicit request for an agent to create visible, committed application source
is a project operation; it does not independently authorize YA's hidden
registry.

## Motivation

The only reason to couple YA with an environment-for-a-web-app panel is
**reach**: the user may be on a tablet or phone over relay, with no knowledge
of how to set such things up. Next to the dev machine, `http://localhost:5199`
already works; from a phone over relay, nothing does — ports, tunnels, TLS,
and auth are exactly the setup a novice cannot do. YA is already the
authenticated, relay-reachable, per-project surface on that machine, so
surfacing the app there is the entire value. YA stays a *container* —
lifecycle, visibility, reach — and never becomes an app framework; the app
itself is independent of the YA codebase, typically customized or built
one-off by the agent in-session for ad-hoc purposes.

Two hard requirements sharpen the scope (maintainer, 2026-07-24): hosting is
**YA-server only** — the app runs from the user's machine through YA's
transports; cloud hosting is right out — and an interactive is **committed
project files**: the scaffolded subdir, registry entry, and per-app guide are
ordinary versioned artifacts in the repo, so an app survives sessions,
travels with a clone, and is reviewable like any other code.

Guiding vision (maintainer, 2026-07-24): "easy enough to use that my kids can
play with it when it is good enough." The bar is a novice — a kid on a
tablet — tapping an icon and playing an agent-built animation or game, not an
operator wiring a deployment. Novice-friendly cuts both ways: *creating* "a
project web app" from a session must be natural for a non-web-dev too, which
is why the convention includes an opinionated app template (below) rather
than leaving each app's organization to per-session improvisation.

Two classes, one registry:

- **Proxied app** — a regular web server (UI or REST) on a loopback dev port
  on the YA machine. YA proxies it through an isolated application host; YA
  does not serve or build it.
- **Served page** — a static rich html+js bundle (no server of its own) that
  YA reads from a project path and delivers only through an isolated
  application host or opaque sandbox. For the novice vision this is the
  *primary* class: a plain html+js animation or game has no process to keep
  alive, so its icon is always live. It is never a raw file served on YA's
  authenticated or hosted-client origin.

## Vocabulary

- **interactive** (noun) — one registered entry: a proxied app or served page
  affiliated with a project.
- **app icon link** — the persistent per-interactive icon YA renders on the
  project's session surfaces.
- **`INTERACTIVES.md`** — optional project doc whose content overrides the
  default prompt prefix injected by the Create Interactive button. Distinct
  from the machine-readable registry below.
- **app template** — v1: a prefab list of project types plus an inherited
  base project-setup prompt, all plain `.md` prompt documents sent to the
  agent, which builds the intended result; no scaffold engine or template
  config language.
- **per-app agent guide** — the `.md` the scaffold places in an app's subdir
  telling the agent how to develop, update, and run that app; update turns
  reference it.
- **meta-UI protocol** — the template-provided in-app affordance and page↔YA
  channel for commenting to the agent inline from the app view.

## App template and per-app agent guide

"Create a project web app" from a session must be natural for a non-web-dev,
so the convention defines a template for how such an app is organized. The
v1 mechanism is deliberately unstructured: **no config language for project
templates**. Instead:

- a **prefab list of project types** (fixed menu in v1 — e.g. game/animation
  page, dashboard, REST tool; exact list open), and
- an **inherited base project-setup prompt**: plain `.md` prompt documents —
  one base md carrying the common conventions (framework and languages,
  likely TS plus a to-be-chosen minimal framework; directory layout;
  authoring the registry entry; creating the per-app guide; wiring the
  meta-UI hook), with each project type's md adding its specifics on top.

These prompt mds are *sent to the agent*, which builds the intended result by
following them — the agent is the scaffold engine. Toolchain availability is
an operator responsibility, not the convention's: the YA server operator
ensures all YA-launched processes (e.g. the Claude TUI) can see the requisite
node and other resources, so the prompts may assume the toolchain rather than
detect or provision it.

The prompts also instruct the agent to create a **per-app agent guide** — a
`.md` in the created app's subdir that tells the agent how to develop,
update, run, and register that named app. A turn about the app references
that guide (the create/update affordances prefix the composer with the
reference), so "make the ball bounce higher" arrives carrying the app's dev
context and the app stays maintainable across sessions. The prompt mds and
guide are where the agent-facing instructions land — they belong to the
convention, not to YA's server code, which never needs to understand the
framework choice.

**In-project templates (v1, additive).** A project can extend the prefab
menu by dropping prompt mds at a conventional path — proposed
`interactives/templates/<name>.md`, exact path open — which YA discovers and
shows in the create-a-web-app UI alongside the built-in project types. Each
is an ordinary committed prompt document, same mechanism as the prefab type
mds. The proposed path also suggests `interactives/<name>/` as the natural
home for the app subdirs themselves; noted under open decisions.

v1 otherwise ships one opinionated, friendly built-in prompt set: additive
in-project types are v1 because discovery-and-list is cheap, while
*overriding* the built-in base setup prompt per project remains the intended
later extension — recorded here so the v1 shape does not foreclose it,
deliberately not built first.

## Registration standard (the project-local config YA checks)

Proposed: `.yep/interactives.json` at the project root, an array of entries:

```jsonc
[
  {
    "name": "coverage-explorer",       // slug; unique within project
    "title": "Coverage Explorer",      // icon tooltip / label
    "icon": "🧭",                       // emoji or project-relative image path
    "kind": "app",                      // "app" (proxied) | "page" (served)
    "port": 5199,                       // app: loopback port to proxy
    "path": "/",                        // app: landing path
    "bundle": "interactives/coverage-explorer/", // page: served dir
    "start": "pnpm --dir tools/cov dev",// optional managed-lifecycle command
    "healthPath": "/"                   // optional liveness probe
  }
]
```

Contract points:

- YA **reads** this file (watch or rescan on project activity); in v1 YA never
  writes it — the agent authors it when it creates the app. Registry, app
  subdir, and per-app guide are *committed* project files (see Motivation);
  YA applies no exclude machinery — unlike [[attachment-storage]], committing
  is the point here, not a leak risk.
- Proxy targets are **loopback-only** (`127.0.0.1:<port>`); the registry must
  not accept arbitrary hosts. Declaring a port in the project's own config is
  the authorization to proxy it.
- A missing/absent registry means the feature contributes zero UI — the
  convention is self-gating, satisfying [[vanilla-defaults]] without a
  separate toggle. (An off switch for icon rendering still belongs in
  [[session-ui-customization]].)
- Hosted-client gating: advertise a `server-capabilities` string so older
  servers don't get dead icon affordances (see [[server-capabilities]]).

Agreed layout split (2026-07-24): `.yep/` is the home for YA-managed state
(this registry); project-authored content — the app subdirs and in-project
template mds — lives in a visible project tree such as `interactives/`,
curated and committed like any other source.

Schema details (multiple pages per entry, auth annotations, REST-only entries
without a UI landing page) are open; start minimal.

## Visibility contract (app icon links)

- Each registered interactive renders as a persistent icon link, project-
  affiliated: visible on sessions belonging to the declaring project — just
  left of the title in recent-session rows and in the main session view
  header.
- Icon click opens the interactive through YA's transport. The primary vision
  is an embedded app-and-session workspace; an independent new-tab view may
  remain a secondary action only when it has a genuine isolated application
  URL. It cannot fall back to a raw main-origin page. Embedding follows the
  sandbox and origin contract under *Security*.
- Liveness: a proxied app whose port is dead renders dimmed (probe =
  `healthPath` or TCP connect), with an affordance to start it when a managed
  `start` command exists. Served pages are always live.
- Hideable via session-UI customization; default-on rendering is acceptable
  only because the project itself opted in by carrying the registry.

### Session/app responsive presentation

The interactive and the session directing its development form one workspace.
When the measured available width can keep both surfaces usable, the intended
presentation is **side by side**: the app remains live while the session stays
visible for reading progress, commenting, and requesting changes. "Wide
enough" is a content-fit decision, not a desktop/tablet device label; a
landscape tablet may qualify while the same tablet in portrait may not.

When both panes cannot remain useful, YA shows one primary surface at a time.
An explicit toggle or collapse control is required; a horizontal switch
gesture is an optional complementary path. Switching between app and session
must preserve the live app state, transcript position, and composer draft
rather than reload either side. The exact narrow-screen control and gesture
remain open, but hiding the session must not remove the template-provided
comment-to-agent affordance from the app view.

## Lifecycle (YA's management role)

YA manages lifecycle/visibility only; it does not own the app's code.

- **v1: observe-only.** Externally started (usually by the agent in-session);
  YA probes liveness, proxies, and renders icons.
- **Later: managed start/stop.** With a `start` command, YA may launch on
  first click and must idle-stop within a bound — an interactive with no
  connected client must not consume server resources indefinitely
  ([[architecture-mandates]]). Managed processes are YA-supervised children,
  reported in the process/status surfaces like other server-owned work.

## Transport and serving

The existing end-to-end-encrypted relay is the defining Interactives
transport, not a fallback. Arbitrary interactive asset, navigation, and
WebSocket forwarding is not implemented; making a YA-owned but origin-isolated
application URL space work over relay is part of this proposal. Template
conventions reduce
absolute-origin breakage but do not remove the proxy work.

An operator may additionally enable **Tailscale**, **Cloudflare Tunnel**, or
both. These are YA-installation-level capabilities configured once and reused
by registered interactives, not setup repeated for each app. They may coexist
with one another and with relay access; neither replaces the requirement that
Interactives work through YA's relay.

The YA proxy boundary:

- A trusted control route may inspect the registry, report liveness, and mint
  a short-lived/revocable entry capability. Browser-visible app bytes and
  WebSockets must not use `/apps/:projectId/:name/*` on the main authenticated
  YA origin; path separation does not remove ambient API authority.
- The application host forwards HTTP and WebSocket traffic to the registered
  loopback port. `createFrontendProxy` is already a parameterized host/port
  HTTP+WS raw-socket proxy — its forwarding core may be generalized rather
  than adding a proxy dependency, but the browser-facing origin and credential
  boundary are new work.
- Admission is scoped to the one interactive and is not a YA API session. The
  application handler strips YA cookies, Authorization, and identity-bearing
  forwarding headers before contacting the loopback app. Over relay, app
  traffic stays E2E-carried without sharing the hosted YA client origin.
- **Never** reachable from public-share surfaces: public-share relay plaintext
  stays restricted to `GET /public-api/shares/...`
  ([[relay-origin-and-share-gating]]); interactives join speech/STT on the
  must-not-tunnel list.

**Optional direct Tailscale path.** When the YA server machine and viewing
device share an enabled Tailscale network, the device can reach the YA proxy
through its isolated application hostname. Tailscale supplies reachability
only; YA still owns the registry, app/session UI, lifecycle, proxy, and scoped
app admission. It does not authorize placing app bytes on the main YA origin.
This is a one-time global machine/device setup, not an Interactives deployment
step.

**Optional global Cloudflare path** (direction set 2026-07-24, after kzahel
suggested Cloudflare tunnels/ngrok as standard localhost-exposure tools and
an authenticated Cloudflare CLI as an agent-operable path, like `gh`). When
Cloudflare reach is globally enabled and an effective tunnel capability is
discoverable, registered interactives can reuse it alongside relay and
Tailscale. The reusable shape tunnels the isolated application handler rather
than creating and configuring a separate tunnel for every app; it does not
expose the trusted YA origin and then separate apps by path. Mechanics:

- Both current CLIs can expose an arbitrary localhost URL. `cloudflared
  tunnel --url http://127.0.0.1:<ya-port>` and `wrangler tunnel quick-start
  http://127.0.0.1:<ya-port>` create quick `*.trycloudflare.com` tunnels;
  Wrangler also exposes general `tunnel create`, `list`, and `run` commands.
  Discovery must probe the exact intended command rather than infer capability
  from a binary name. See the official
  [Wrangler tunnel commands](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/)
  and
  [Quick Tunnel constraints](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
- Auth comes in distinct capability levels and discovery must distinguish
  them: **quick tunnels need no account auth**, but an executable capability
  probe is still required — for example, `cloudflared` Quick Tunnels are not
  supported when a `.cloudflared/config.yaml` file is present. A
  **named-tunnel run token** (dashboard-managed; no local `cert.pem`) can
  only run its one tunnel, not create tunnels or hostname routes; **origin
  cert or API auth** is what permits creating named tunnels and routing
  hostnames. An operator already running a dashboard-managed named tunnel
  (e.g. for a relay server) proves the account and could add interactive
  hostnames to that tunnel via dashboard/API, but the host's run token alone
  cannot.
- A tunnel process launched by YA is a YA-managed child under the
  [[architecture-mandates]] idle bounds. YA need not own an already-running
  globally configured tunnel.
- The preferred reusable tunnel terminates at the YA machine but routes the
  dedicated application hostname to the isolated app handler, not to a shared
  main-origin path. A tunnel is reachability, not permission. A separately
  public app URL bypasses scoped app admission and is a distinct deliberate
  exposure change: explicit, default off ([[vanilla-defaults]]), and visibly
  marked. A named tunnel can add Cloudflare Access.
- Consistency with the hard requirement: a tunnel is *transport to the YA
  machine*, not cloud hosting — the app and its files stay local and
  committed. "Cloud is right out" rejects hosting, not a tunnel.

**Live loop, not deploy-on-push.** The container is deliberately more
intuitive and interactive than see-the-effect-only-on-push flows (pre-push
hooks that build and deploy a website, Pages-style deploys): the app runs
live on the YA machine and iteration is immediate for both agent and user. A
push-deployed public/prod side remains a nice optional extension when a
project defines one — a matured interactive graduating to a real deploy
target — and is out of v1 scope.

## Security

The complete contract is [[active-content-security]]. Its confirmed
2026-08-01 reproduction showed that agent-written HTML opened on
`/api/local-file` could call authenticated process APIs. Interactives are the
intentional executable version of the same content class, so they must solve
the origin boundary before either app kind is implemented.

The trust boundary ([[security]]) permits the *reach*: local and authenticated
remote operators may already command powerful agents. It does not permit
**ambient authority under YA's origin**. YA auth is an HttpOnly
`yep-anywhere-session` cookie (`packages/server/src/auth/routes.ts`), so
interactive JS cannot read the credential value, but same-origin code can make
authenticated `/api/*` requests as the operator. On the hosted client origin,
the analogous ambient state includes browser-local login/resume material even
though that static host has no local `/api` backend.

Required posture:

- app bytes never execute on the authenticated YA origin or hosted-client
  origin; path separation and a CSP on `/apps/...` are insufficient;
- the default embedded app is an opaque-origin sandbox, with `allow-scripts`
  only because execution is the feature and without `allow-same-origin`;
- a dedicated untrusted-content hostname is required for top-level/new-tab
  apps and for apps that need a stable multi-asset origin; a separate port on
  the same host is not the preferred boundary because cookies are not
  port-scoped;
- the app host exposes no YA API/control routes, receives no YA cookie or
  browser storage, and gets only a scoped app-entry capability;
- proxy forwarding strips ambient credentials before reaching the loopback
  app; and
- the only YA capability available to template-built apps is the validated,
  brokered meta-UI channel below.

An informed-consent warning is not an isolation fallback. It cannot satisfy
the sandboxed-agent or kid-playable use case and must not be described as
equivalent protection. A separately explicit "open external localhost app"
operator action may exist, but it is outside the isolated Interactives
guarantee and cannot be the novice/default path.

The meta-UI protocol (below) reinforces this posture: a templated app's only
channel to YA is a brokered message channel, so it needs no ambient authority
at all.

Hosted-client wrinkle: on `ya.graehl.org` the client reaches the server
through the relay, not direct HTTP, so an iframe `src` has no plain local app
URL to point at. Serving assets needs either a dedicated untrusted-content host
reached through a scoped relay/broker or a trusted client that fetches a
complete bundle and constructs an opaque sandbox with brokered assets. It must
not use a service worker, blob top-level page, or `srcdoc` without sandboxing
on the hosted YA client origin.

A standard unmodified web app is difficult to carry over relay: every fetch,
asset URL, navigation, worker, and WebSocket must resolve through the isolated
app transport, and absolute-origin assumptions break it. That is significant
machinery for arbitrary apps and another argument for the template: the base
prompt md mandates relay-compatible conventions (relative URLs, no hardcoded
origins, and WS via the isolated served path). Optional direct Tailscale or
Cloudflare access does not remove that core relay or isolation requirement.

## Meta-UI protocol (comment-to-agent from the app view)

The template bakes a meta-UI affordance into every scaffolded app: from the
running app's view, the user can comment inline to the agent — a small
overlay/widget, not something each app reinvents. Mechanically it is a
page↔YA channel: under the sandboxed-iframe posture, `postMessage` brokered
by the embedding YA client is the natural transport, and it doubles as the
*only* capability an app is granted — comments need no cookie or `/api/*`
authority. A comment (plus optional app-supplied context such as the tapped
element or app state) lands in the session composer for the user to send
(v1; auto-send is a later opt-in), consistent with [[vanilla-defaults]].
The parent validates the schema and expected child window. An opaque child has
`event.origin === "null"`, so source-window and per-app capability checks are
mandatory and the parent never posts ambient secrets to a wildcard target.
This is the freeform, app-side sibling of [[rich-interviews]]: the same
input-back-to-agent direction, but unstructured in-app comments rather than
structured multi-round forms.

## Create Interactive button

A composer-adjacent action whose type chooser lists the prefab project types
plus any in-project templates, then prefills the composer with the base
project-setup prompt and the chosen type's prompt (or references to
them), so the agent builds the app to the convention. An update affordance
on an existing app similarly prefixes a reference to that app's per-app
agent guide. The default create prefix is built-in; a
project overrides it by carrying `INTERACTIVES.md`, whose content precedes the
user's turn in the composer. Because the prefix lands *in the composer* —
visible, editable, sent verbatim only when the user sends — it is an
explicitly invoked transform in [[vanilla-defaults]] terms, like emulated
slash-command expansion. This button is the piece that serves the novice
vision most directly (tap → describe the game you want), and also the first
piece to cut if the container concept shrinks — it is sugar, not structure.
The agent-facing instructions/skills that make the build reliable are TBD and
belong beside the standard once it stabilizes.

## Relation to rich interviews

[[rich-interviews]] (the annotator/interview flow) was originally drafted as a
section here and is deliberately separate: its intent is routine structured
input consumed by workflows/skills, its lifecycle is issued-into-a-session
rather than project-persistent, and its likely v1 (YA-rendered declarative
forms) shares no implementation with this container. The one seam: if an
interview ever needs arbitrary DOM expressiveness, it may embed an
interactive — a directional reference, not shared ownership. As of
2026-07-24 rich interviews are banked entirely (lower incremental value);
the working bet is that this container's machinery — template, meta-UI
protocol, embedding — accumulates until the interview use cases become
easily buildable on top.

## Prior art

Learn-from targets — source code, demos, marketing — from a 2026-07 survey
pass. Study their interaction patterns and bridge protocols; their cloud
hosting models are explicitly rejected by the YA-server-only requirement:

- **GitHub Spark** — natural-language micro-apps ("sparks") on an opinionated
  managed runtime (storage, theming, LLM access) with a PWA dashboard for
  launching them from anywhere, hosted behind GitHub auth. Validates the
  shape — template + registry + icon dashboard + zero-setup reach — while its
  Azure hosting is exactly what the requirement rejects: the shape transfers,
  the hosting model does not.
  (https://github.com/features/spark,
  https://githubnext.com/projects/github-spark/)
- **Lovable "Visual Edits" / preview toolbar** (similarly v0, Bolt.new) —
  select elements in the running preview, describe the change in plain
  language, send to the agent to iterate; selected elements attach to the
  chat input as references. The meta-UI protocol is this pattern generalized
  to template-scaffolded apps, and the composer-landing v1 matches the
  attach-to-chat-input behavior.
  (https://docs.lovable.dev/features/preview-toolbar)
- **MCP Apps standard / ChatGPT Apps SDK** — embedded app UIs run in a
  sandboxed iframe (ChatGPT: a dedicated `*.web-sandbox.oaiusercontent.com`
  origin with per-widget CSP) and talk to the host via `ui/*` JSON-RPC over
  `postMessage` (`window.openai` wraps it). Directly validates the
  sandbox-plus-brokered-channel posture; evaluate MCP Apps as the meta-UI
  message schema before defining a YA-private one.
  (https://developers.openai.com/apps-sdk/build/chatgpt-ui,
  https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)
- **Claude Artifacts** — agent-built single-page apps rendered in a sandboxed
  iframe beside the chat; precedent for the served-page class and for tight
  default sandboxing of agent-authored code. <!-- assumed; not re-verified in
  this survey pass -->

None of them cover YA's actual coupling reason: the app living on the user's
own dev machine inside a project checkout as committed files, reached over
the operator's authenticated relay rather than vendor hosting.

## Open decisions

- Registry filename within `.yep/` (the `.yep/` home for YA-managed state is
  agreed 2026-07-24) and minimal v1 schema.
- The v1 prefab project-type list, and the framework/language choices and
  layout conventions the base prompt md pins down (including where app
  subdirs live, served-page vs proxied-app cases — `interactives/<name>/`
  if aligned with the in-project templates path).
- The in-project templates path (`interactives/templates/<name>.md` proposed)
  and how template titles/descriptions surface in the create-UI menu.
- Per-app agent guide filename and required sections.
- Whether served-page bundles commit built output (servable from a fresh
  clone with no build step) or commit source only and rebuild on update
  (toolchain presence is an operator guarantee either way).
- Meta-UI channel mechanics (message schema, child/source authentication,
  context payload, composer delivery vs queued turn; a scoped fallback channel
  for isolated new-tab opens where no embedding parent exists).
- Minimum useful pane widths, the narrow-screen toggle/collapse and optional
  switch gesture, and whether new-tab remains a secondary action; sandbox
  behavior across target browsers, without treating cookie withholding as the
  only security boundary.
- Direct and hosted untrusted-content hostnames, scoped admission, cookie and
  proxy-header stripping, hosted-client relay asset serving, and whether apps
  share one isolated origin or receive per-app storage origins.
- Managed-lifecycle idle-stop bound and its status surface.
- Optional-route selection and UI when global Tailscale and/or Cloudflare
  access is enabled; quick vs named Cloudflare tunnels; Cloudflare Access
  policy; the "present + authed + effective" discovery test across the auth
  capability levels above; tunnel-child idle bound.
- Optional push-deployed public/prod side for a matured interactive, when a
  project defines a deploy target.
- Whether REST-kind entries get a YA-rendered landing (request console) or
  just a link.

## See also

- [[security]], [[relay-origin-and-share-gating]] — trust boundary and the
  must-not-tunnel list this extends.
- [[active-content-security]] — binding source/preview and isolated-origin
  contract for every app delivery mode.
- [[rich-interviews]] — the split-out interview flow and its embed seam.
- [[vanilla-defaults]], [[session-ui-customization]], [[server-capabilities]] —
  gating and visibility discipline.
- [[architecture-mandates]] — resource bounds for any managed lifecycle.
