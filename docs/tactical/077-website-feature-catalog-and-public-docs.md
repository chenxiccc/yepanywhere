# Website Feature Catalog And Public Docs

Status: implementation complete on 2026-08-01; the authenticated analytics
baseline and production `site-v*` release remain release-time Maintainer work.

Related surfaces:
[`site/src/pages/index.astro`](../../site/src/pages/index.astro),
[`site/src/components/Header.astro`](../../site/src/components/Header.astro),
[`site/src/layouts/BaseLayout.astro`](../../site/src/layouts/BaseLayout.astro),
[`site/src/pages/privacy.astro`](../../site/src/pages/privacy.astro),
[`site/src/pages/spring-2026.astro`](../../site/src/pages/spring-2026.astro),
[`packages/desktop/README.md`](../../packages/desktop/README.md),
[`packages/mobile/package.json`](../../packages/mobile/package.json),
[`README.md`](../../README.md), and the current internal
[`docs/project/`](../project/) records.

## Objective

Make Yep Anywhere's breadth understandable before a visitor has to read a
release recap or inspect the repository, and give prospective and current
users a durable public documentation path from first visit through advanced
workflows.

The product surfaces have three distinct jobs:

- the homepage explains why Yep Anywhere is useful and moves a visitor toward
  a concrete next step;
- `/features` presents the complete, honest product catalog; and
- `/docs` teaches installation, connection, configuration, workflows,
  security, and recovery.

A typed public feature registry is the editorial source of truth shared by
the homepage and feature catalog. It must prevent the current drift between
the homepage, FAQ, README, comparison articles, and release recaps without
pretending to be a live server-capability negotiation mechanism.

## Starting evidence — 2026-08-01

The live homepage was inspected at desktop and phone widths. A full-page
capture measured 1,920 x 8,532 on desktop and 375 x 14,161 on mobile. The
current feature grid begins only after the hero, five value propositions, the
Remote Control comparison, seven phone screenshots, and three desktop
screenshots. On mobile, the navigation also hides the existing Screenshots,
Features, and FAQ anchors.

The homepage contains a useful but flat ten-card feature list. It does not
explain a substantial part of the shipped product, including:

- Project Queue, queued follow-ups, steering, and heartbeat turns;
- session search, recaps, forking/cloning, and global activity views;
- public read-only session sharing;
- source-control review, safe pull/push, and the scoped file viewer;
- model switching, explicit thinking/effort controls, and richer provider
  support;
- hosted and local speech-to-text backends; and
- the localized client.

Public claims already disagree. The homepage comparison names Claude, Codex,
and Gemini; its FAQ names Claude, Codex, and experimental OpenCode; the README
support table lists only Claude and Codex; and the spring recap also names
Grok Build, Ollama, and deeper OpenCode support. All of those surfaces omit the
already-shipped experimental pi provider. This is a content-ownership defect,
not merely a copywriting gap.

Installation claims are stale too. Signed macOS and Windows desktop installers
are available from GitHub Releases, but the website's spring recap still calls
the desktop app "coming soon." The desktop apps are beta while they approach
release readiness and must be presented that way rather than hidden or promoted
to stable. The Android app is in development and is not published. It
must not receive a download or installation CTA until an explicit publication
gate is met. The mobile browser interface remains the currently available
phone experience.

The repository's existing `docs/project/` tree is not a ready-made public docs
site. It mixes architecture, implementation plans, historical proposals, and
security-sensitive design detail. User-facing material currently lives across
the README, news articles, feature-specific pages, and internal topics.
Publishing that tree wholesale would expose the wrong audience and leave
basic user journeys fragmented.

Cloudflare Web Analytics is present in `BaseLayout.astro` and the live
homepage successfully sends its RUM request. It covers Astro marketing,
article, and future docs pages that use the shared layout. The deployed
`/remote/` client does not include the beacon. The current privacy page
incorrectly says the website uses no analytics and also still describes the
public relay as future work.

Cloudflare's current website analytics can answer aggregate questions about
visits, page views, paths, referrers, device classes, countries, load time, and
Core Web Vitals. It cannot report custom CTA events or UTM parameters. The
first implementation should make important steps distinct page paths so the
existing privacy-first analytics remain useful without adding another
tracking provider.

## Product and editorial decisions

- **One catalog owns public feature facts.** The homepage selects highlights
  from it and `/features` renders the complete catalog. Do not hand-copy a
  second list into either page.
- **Installation channels have their own registry.** npm, macOS desktop,
  Windows desktop, the browser client, and future published apps are product
  distributions, not ordinary features. Keep their platform, status, download
  location, prerequisites, and update path in a sibling typed registry.
- **The catalog contains only shipped features.** A status distinguishes
  stable from experimental behavior. Planned work stays in roadmaps and
  release communication, not in the public feature registry.
- **Desktop downloads are discoverable and honestly beta.** Link the
  macOS and Windows installers on GitHub Releases from Getting Started and the
  relevant homepage installation choice. Do not call them generally available
  until a separate release-readiness decision promotes them.
- **Android remains development-only.** It may appear in a platform-availability
  explanation as "in development — not published," but it must never render a
  download link, installation command, or implication that a public APK/store
  release exists. Do not infer an iOS release from the shared mobile package.
- **Availability is explicit.** Provider-, platform-, connection-, or
  configuration-specific features say so. A feature that is experimental for
  one provider must not inherit a blanket stable claim from another.
- **The catalog is editorial, not protocol state.** It describes the current
  released product for readers. It must not replace server capabilities,
  provider contracts, or hosted-client compatibility gates.
- **Marketing and documentation stay distinct.** Feature summaries lead with
  user outcomes. Docs contain requirements, procedures, configuration names,
  security boundaries, and troubleshooting.
- **Internal records are source material, not public pages.** Public docs may
  be derived from `topics/`, `docs/project/`, and code, but their language and
  stability must be reviewed for users.
- **The homepage becomes shorter and more selective.** It should demonstrate
  the product rather than inventory every capability or present a standalone
  wall of screenshots.
- **Existing analytics are enough for the first pass.** Do not introduce a new
  analytics dependency or collect product-session behavior. Keep `/remote/`
  outside the marketing beacon unless a later privacy and product decision
  explicitly changes that boundary.
- **Important journeys use measurable routes.** `Get started` goes to
  `/docs/getting-started`, and feature highlights link to their catalog or docs
  pages instead of relying on same-page anchors.
- **Docs begin without client-side search.** Add it only after the initial
  corpus proves that navigation and browser find are inadequate. The static
  Astro site should remain lean.

## Proposed information architecture

The primary header should have a stable shape across marketing, article, and
docs pages:

```text
Features    Docs    News    GitHub    Log In    Get started
```

`Get started` is the primary action. `Log In` remains visually distinct but is
worded and placed as an action for an existing installation, not as the main
onboarding route. A compact mobile menu must preserve access to Features and
Docs rather than hiding the product-discovery links.

### Homepage narrative

1. Hero: the category, primary outcome, and local-machine boundary.
2. Product proof: one strong composed product view or one short visual story.
3. Three promises: supervise anywhere, coordinate many agents, and keep work
   local/private.
4. Six catalog-backed feature highlights with links for deeper exploration.
5. Connectivity and trust: direct access, public relay, self-hosted relay,
   end-to-end encryption, and local session storage.
6. Installation choice: beta desktop downloads or the stable npm
   path, continuing into Getting Started.
7. A final Get started / Explore features decision.

Screenshots should be placed beside the capability they prove. A separate
gallery may remain only if it adds views not already used in the narrative and
does not dominate the phone page.

### Feature catalog categories

| Category | Representative public capabilities |
| --- | --- |
| Supervise anywhere | Mobile approvals, push notifications, file uploads, voice input, server-owned sessions |
| Run many agents | Tiered inbox, activity stream, search, recaps, steering, session queue, Project Queue |
| Use preferred agents | Claude Code, Codex, provider interoperability, model switching, effort controls, experimental providers |
| Review and ship | Diffs, file viewer, source control, session sharing, remote device control |
| Connect securely | Direct/LAN, public relay, self-hosted relay, end-to-end encryption, local data ownership |

Each category starts with one outcome-oriented explanation. Feature cards then
show status and narrow availability as needed, and link to an owning guide.
Avoid presenting transport names or cryptographic primitives as the benefit;
use them as supporting proof beneath the user-facing claim.

### Platform and distribution availability

Keep installation status adjacent to, but structurally separate from, the
feature catalog:

| Distribution | Public state | Public action |
| --- | --- | --- |
| npm/server install | Available | Show supported install and update commands |
| macOS desktop app | Beta | Link signed/notarized GitHub Release downloads |
| Windows desktop app | Beta | Link signed GitHub Release installers |
| Mobile browser client | Available | Explain that no native app is required |
| Android app | In development, not published | No download CTA; state status only where needed |

Do not label the desktop apps stable merely because their internal desktop
README calls the shell stable. The public release-stage wording follows the
Maintainer's explicit beta classification until it is promoted. Do
not present the Android device-control companion as the end-user Android app;
they are different products.

### Initial public docs tree

```text
Docs
├── Start here
│   ├── What Yep Anywhere is
│   ├── Requirements
│   ├── Choose an installation method
│   ├── Desktop apps (beta)
│   ├── Install from npm
│   └── Updating
├── Connect remotely
│   ├── Choose a connection method
│   ├── Direct LAN or Tailscale
│   ├── Public relay
│   └── Self-hosted relay
├── Providers
│   ├── Supported providers
│   ├── Claude Code
│   ├── Codex
│   └── Experimental providers
├── Workflows
│   ├── Sessions, approvals, and permission modes
│   ├── Steering and queued follow-ups
│   ├── Project Queue
│   ├── Search and session recaps
│   ├── Fork and clone sessions
│   ├── Share a session
│   ├── Review source control
│   └── Control a remote device
├── Configure
│   ├── Notifications
│   ├── Voice input
│   ├── File access
│   └── Environment variables
├── Security and privacy
└── Troubleshooting
```

The first release need not fill every leaf with a long guide. It must include
the complete navigation shape, a useful landing page, and the minimum guides
named in step 7 below. A short, accurate page is better than a link to an
internal proposal or an empty placeholder.

## Recommended implementation order

### 1 — establish the public product-communication contract

Create an owning `topics/website-product-communication.md` contract before
changing the rendered site. Record the externally observable boundaries:

- the jobs of the homepage, feature catalog, and docs;
- which claims the feature registry owns;
- stable versus experimental status semantics;
- distribution states and the rule that development-only apps have no public
  download action;
- the separation between editorial availability and runtime capabilities;
- the marketing analytics boundary, including the deliberate `/remote/`
  exclusion; and
- the required fallback when a feature has no guide yet.

Inventory current public claims against released behavior and the owning topic
documents. Resolve each provider and platform discrepancy with code/release
evidence rather than choosing the broadest marketing statement. Record
uncertain claims as questions; do not silently promote them to stable.

Acceptance:

- every existing homepage/README feature claim maps to a verified catalog
  candidate, a corrected status, or an explicit removal;
- the current supported and experimental providers have reviewed wording;
- npm, browser, macOS desktop, Windows desktop, and Android distribution states
  have reviewed wording and evidence;
- the owning observable-behavior contract exists; and
- no planned-only capability is queued for public catalog inclusion.

### 2 — build the typed feature registry

Add a site-owned registry such as `site/src/data/features.ts`. Keep the public
type small enough to review but rich enough to prevent bespoke page copy:

```ts
type PublicFeatureStatus = "stable" | "experimental";

interface PublicFeature {
  id: string;
  title: string;
  summary: string;
  category: PublicFeatureCategory;
  status: PublicFeatureStatus;
  availability?: PublicFeatureAvailability;
  docsPath?: `/docs/${string}`;
  image?: PublicFeatureImage;
  featured?: boolean;
  sourceRefs: string[];
}
```

Use stable feature and provider ids, not display strings, for relationships.
If provider summaries need enough independent metadata to avoid another table
drift, add a sibling `providers.ts` registry and have feature availability
reference it. Do not import server runtime capability types into the static
site merely to reuse names with different semantics.

Add a sibling distribution registry rather than treating installers as feature
cards:

```ts
type PublicDistributionStatus =
  | "available"
  | "beta"
  | "development";

interface PublicDistribution {
  id: string;
  platform: string;
  status: PublicDistributionStatus;
  docsPath: `/docs/${string}`;
  downloadUrl?: string;
  sourceRefs: string[];
}
```

Validation must reject a `development` distribution with a download URL. The
macOS and Windows entries use `beta` and link to the canonical GitHub
Releases surface rather than embedding versioned asset URLs throughout page
copy. The Android entry uses `development` and has no download URL.

Add a catalog validation command that fails on duplicate ids, unknown
categories/providers, invalid status values, missing featured media, and docs
paths that do not resolve once a guide is marked published. Make that check
part of `pnpm site:build` or an equivalent site verification command.

Acceptance:

- the registry represents the reviewed shipped catalog;
- its types prevent free-form category, status, and provider spellings;
- distribution types prevent a development-only app from acquiring a public
  download CTA;
- a broken reference or duplicate id fails locally and in CI;
- a server runtime provider with no public registry mapping fails the site
  build;
- the catalog can be rendered without per-page copies of its title, summary,
  status, or availability; and
- source references let a maintainer re-check each non-obvious claim.

### 3 — publish the complete feature catalog

Create `/features` from the registry. Render the approved categories in a
clear reading order, with stable/experimental badges and concise availability
notes. The page should answer three questions without requiring a news post:

1. What can Yep Anywhere do?
2. Does this work with my provider or setup?
3. Where do I learn how to use it?

Include a compact platform/installability section sourced from the distribution
registry, but do not mix desktop installers into the capability-card grid. It
must make the beta macOS and Windows apps discoverable and distinguish
the available mobile browser experience from the unpublished Android app.

Add appropriate title, description, canonical URL, Open Graph metadata, and
structured data only where the schema truthfully fits. Feature links without a
published guide should lead to the closest useful docs section, not to a dead
route or an internal design record.

Acceptance:

- every catalog item renders exactly once in the full catalog;
- status and availability remain legible on phone widths;
- availability notes distinguish optional exposure from experimental maturity,
  with Project Queue labeled stable and opt-in;
- desktop download links and Android development status match the distribution
  registry;
- each rendered link resolves in the production-style Astro build; and
- the catalog remains useful with images disabled and to assistive technology.

### 4 — make the homepage a concise product narrative

Reorder and reduce `index.astro` according to the approved homepage narrative.
Render its feature highlights by selecting `featured` catalog entries rather
than recreating cards. Replace the standalone screenshot wall with contextual
visual proof and a smaller optional remainder gallery.

Lead with the core product promise: full access to supported agents and
workflows from every device, without dropping into a cut-down remote mode.
Local execution and server-owned persistence support that outcome rather than
replacing it as the headline. Treat the Remote Control comparison as supporting
discovery content rather than the organizing principle of the homepage. Make
the cross-device advantage explicit: a browser on another computer is as valid
a controller as a phone.

Present the product as intentionally familiar and simple by default for people
who already know Claude Code or Codex through a CLI or desktop app. Surface the
deeper coordination, review, sharing, voice, and device-control capabilities as
optional depth rather than prerequisites. Mention that the application UI is
available in six languages without implying that the public website is already
localized.

Follow the hero with a prominent “Why Yep Anywhere?” section. Explain that the
surveyed alternatives may forward an agent chat, while Yep Anywhere combines
multi-agent workflow breadth, a full client on every device, complete session
and tool-call visibility, local ownership, direct/self-hosted access, and an
end-to-end encrypted authenticated relay. Explain that full-fidelity transcripts
can be shown as a calmer condensed conversation or with routine activity
collapsed. Keep the opt-in public-share privacy exception explicit and phrase
the survey as what the project found rather than an eternal universal claim.
Compare against Claude and Codex first-party Remote Control through durable
differences—provider-neutral browser access, host choice, session management,
and self-hosting—not a blanket claim that first-party control is always
phone-only.

Add concrete security-maintenance proof near the trust story: the deliberately
small runtime dependency surface, regular maintainer-led audits, and the two
public core maintainers, Jonathan Graehl (`@graehl`) and Kyle Graehl
(`@kzahel`). Link verified public profiles and do not imply independent security
certification.

The installation preview should offer the beta desktop path and the
stable npm path without turning the hero into a download matrix. Make clear
that the phone experience works in the browser; do not advertise the Android
app or imply that it is needed for mobile supervision.

Acceptance:

- a first viewport identifies the product, supported primary providers, local
  execution boundary, and primary next action;
- the headline leads with full cross-device agent access rather than the generic
  fact that agents continue running;
- the first viewport presents a familiar default workflow, optional advanced
  depth, and the application's six-language UI without claiming the website is
  localized;
- the first major section answers why the product exists and names the combined
  capability, security, and privacy advantage;
- the Why section distinguishes full transcript and tool-call visibility from
  the optional condensed, less-verbose presentation;
- the trust section names minimal dependencies, maintainer-led audits, and both
  core maintainers with verified public identity links;
- Features and Docs are reachable from desktop and mobile navigation;
- exactly one primary Get started action points to
  `/docs/getting-started`;
- featured copy comes from the registry; and
- the first-party comparison explains computer-to-computer control without
  making a stale absolute claim about provider device support; and
- the phone page no longer requires traversing a long screenshot column before
  reaching feature breadth or installation guidance.

### 5 — expose desktop downloads and platform status

Add a focused installation chooser within Getting Started, with a concise
homepage entry point. Present the current options in this order:

1. macOS desktop app — beta GitHub Release download, with Apple
   Silicon and Intel choices;
2. Windows desktop app — beta GitHub Release installer;
3. npm/server install — supported command-line path and source-checkout
   alternative; and
4. mobile access — use the browser/PWA against an existing server.

The desktop guide should explain that the installers bundle Yep Anywhere's
runtime but expect Claude or Codex to be managed separately, name current
platform/architecture coverage, link to release notes, and give the supported
update/reinstall recovery path. Keep detailed developer smoke commands in the
desktop README rather than copying them into user docs.

Remove or qualify current website copy that calls the desktop app "coming
soon." Dated news prose can remain historically accurate if it is visibly
dated, but its current CTA should lead to the beta downloads or docs.

State Android only where platform availability is being clarified:
"Android app in development — not yet published." Do not offer an APK, store
badge, waitlist, or installation instructions in this slice. Do not confuse
remote Android device control with the Android client app.

Explain why no native mobile app is published yet: the browser already exposes
the complete workflow, while a native companion must earn its install through
more reliable background notifications, deep links, trusted packaging, and
multi-server triage rather than shipping as a thin wrapper.

Acceptance:

- current macOS and Windows GitHub Release downloads are reachable from public
  Getting Started documentation;
- both desktop platforms are visibly labeled beta;
- architecture/installer choices are understandable without opening the
  workflow YAML or developer README;
- Android has no public download action and is never described as available;
- browser-based mobile supervision remains the default documented phone path;
  and
- stale current-context "coming soon" desktop copy is removed or qualified.

### 6 — build the public docs shell

Add a site-owned docs content collection and layouts for `/docs`. Use Astro's
build-time content facilities and the existing shared visual tokens; do not add
a client documentation framework or search dependency for the first version.

The docs layout needs:

- a landing page organized around newcomer and returning-user tasks;
- hierarchical navigation with a visible current-page state;
- previous/next navigation within a section;
- stable generated heading anchors;
- a compact on-page table of contents when a guide warrants one;
- usable code blocks and copyable commands; and
- consistent links back to Features, GitHub issues, and the remote login where
  relevant.

Keep marketing paragraphs out of procedural guides. Clearly label defaults,
optional/experimental behavior, destructive operations, security boundaries,
and setup-specific prerequisites.

Acceptance:

- all initial docs routes build as static pages with canonical metadata;
- navigation works without JavaScript and remains practical at 375px;
- heading links, code blocks, focus order, and active navigation are accessible;
- the docs shell introduces no new runtime dependency; and
- internal `topics/` or `docs/project/` pages are not accidentally published.

### 7 — author the minimum complete user journey

Write and review these guides before calling the public docs launch useful:

1. What Yep Anywhere is and what remains on the user's machine.
2. Choosing an installation method: beta desktop app or npm/server.
3. Desktop first launch, provider detection, and update/reinstall recovery.
4. npm/source installation, first launch, provider detection, and updating.
5. Choosing direct, public-relay, or self-hosted remote access.
6. The supported-provider matrix with stable/experimental distinctions.
7. Sessions, approvals, permission modes, steering, and queued follow-ups.
8. Project Queue.
9. Notifications and voice input.
10. File access and source-control safety boundaries.
11. A troubleshooting index with logs, connection recovery, and issue-report
    evidence.

Derive procedures from current code and binding topics. Do not copy historical
implementation narration or stale examples. When a guide describes an
optional hosted-client feature, verify its server-capability behavior and
absence fallback before claiming it works against older installs.

Acceptance:

- a new user can install, open, connect remotely, and start or resume a session
  using only public docs;
- an existing user can update and diagnose the common failure paths;
- every documented default agrees with the owning runtime contract; and
- storage documentation names the macOS/Linux and Windows defaults and keeps
  desktop data separate from npm/source data; and
- each guide has one named owner/source set for later freshness review.

### 8 — align public claims and retire duplicate inventories

Update the README, FAQ, comparison page, and relevant news links after the
registry and docs routes exist. The README should keep a concise, durable
summary and link to the canonical catalog rather than maintain another
exhaustive feature list. Its provider summary should come from the same
reviewed provider facts or remain deliberately high-level.

News articles remain dated records and do not need rewriting whenever a
feature evolves, but their calls to action should lead to the current docs or
catalog. Add a visible dated-article treatment when a statement could otherwise
be mistaken for present compatibility.

Acceptance:

- homepage, feature catalog, FAQ, and README no longer disagree about primary
  provider support;
- current pages no longer describe released desktop artifacts as merely
  forthcoming or imply that the Android app is published;
- public navigation contains no link into internal architecture as the sole
  user guide;
- old URLs retain useful content or redirect safely; and
- an explicit search for the retired contradictory claims finds only dated or
  intentionally qualified history.

### 9 — correct privacy copy and define analytics ownership

Update the privacy page to disclose Cloudflare Web Analytics accurately. State
what the marketing/docs beacon measures at an aggregate level, link to the
provider's current privacy explanation, and distinguish website analytics from
the self-hosted app, optional update checks, relay metadata, and `/remote/`.
Update the public-relay section from future tense to current behavior after
checking it against the relay privacy contract.

Make the public-share exception explicit wherever authenticated relay privacy
is summarized. Public sharing is opt-in because the current share path is
readable by the relay operator; a deliberate share link must never inherit the
end-to-end-encryption claim made for authenticated Remote Access.

Keep the beacon in one shared marketing/docs layout. Add a narrow regression
check that the marketing homepage and docs include the expected beacon while
the built remote client does not. The public token is configuration, not a
secret, but avoid duplicating it across generated pages or components.

Acceptance:

- the rendered privacy page and network behavior agree;
- `/remote/` remains outside the marketing beacon;
- all intended marketing/docs pages inherit analytics through one owner; and
- feature catalog, docs, privacy, README, and relay history state that public
  sharing is opt-in because the relay operator can read shared content; and
- no statement implies that the website, update service, public relay, and
  self-hosted application share one collection policy.

### 10 — establish a website measurement baseline

Use the existing Cloudflare dashboard to record a pre-change baseline for the
largest useful comparison window available before release:

- visits and page views;
- top landing paths and referrers;
- desktop/mobile/tablet split;
- views of current installation and feature anchors where they can be
  inferred; and
- Core Web Vitals and page-load summaries.

After release, review `/features`, `/docs`, `/docs/getting-started`, provider,
and remote-access path traffic at 7 and 30 days. Treat these as navigation
signals, not proof that an installation succeeded. Do not invent a conversion
rate from missing custom events.

If the team later needs outbound-click or completed-install funnels, open a
separate privacy/product decision covering the exact event vocabulary,
retention, disclosure, and provider. Do not smuggle event tracking into this
content project.

Acceptance:

- the pre-change date range and aggregate values are recorded outside source
  code or in a deliberately tracked report;
- the post-release review dates and path questions have owners;
- the dashboard can distinguish docs/catalog interest through real paths; and
- no custom analytics dependency is added in this slice.

### 11 — verify the complete public-site journey

Run `pnpm site:build` and make the site build part of ordinary CI when `site/`
or its shared catalog inputs change. Add focused tests for catalog validation,
route/link integrity, metadata, navigation state, and the analytics inclusion
boundary.

Perform final browser verification at 1,920 x 1,080 and 375 x 812 for at least:

- homepage;
- feature catalog;
- docs landing page;
- installation chooser and desktop guide;
- a long procedural guide with code blocks;
- mobile navigation; and
- the corrected privacy page.

Inspect rather than merely capture the images. Check content density, text
measure, touch targets, screenshot cropping, status badges, code overflow,
focus visibility, light/dark themes, and reduced-motion behavior where motion
exists. Run a broken-link crawl against the built output and inspect the
generated sitemap.

Acceptance:

- the site build and focused checks are warning-free;
- all internal links and production-style file-format routes resolve;
- final desktop and phone captures satisfy the requested information
  hierarchy;
- no regression adds analytics to `/remote/`; and
- the site changelog records the public behavior and disclosure changes.

### 12 — release and close the communication baseline

Release through the existing `site-v*` workflow only after the marketing site,
docs, privacy disclosure, and remote-client artifact have passed the same
deployment build. Do not treat a push to `main` as a website release.

After production deploy:

- smoke the homepage, `/features`, `/docs`, `/docs/getting-started`, privacy,
  sitemap, and `/remote/`;
- smoke the macOS and Windows GitHub Release links and confirm Android renders
  no download action;
- confirm one live marketing/docs RUM request and the deliberate absence of one
  in `/remote/`;
- record the shipped catalog counts by category and status;
- record any intentionally deferred docs leaf with a concrete reason and safe
  fallback link; and
- set the 7-day and 30-day analytics review dates.

The tactical closes when the canonical public feature catalog and the minimum
complete docs journey are live, their claims are aligned across public
surfaces, and the analytics/privacy boundary is both accurate and verified.

### 13 — localize the public website

Status: roadmap follow-up, not part of the current English-language release.

Extend the localized application experience to the marketing and documentation
site through locale-specific static routes and an accessible language switcher
in desktop and mobile navigation. Start with the six application languages:
English, Chinese, Spanish, French, German, and Japanese.

Define one source-language workflow, translation ownership, fallback behavior,
and a freshness check before publishing partial locales. Translate the core
journey as a coherent unit: global navigation, homepage, feature catalog,
Getting Started, remote-access and privacy guides, metadata, and error pages.
Add locale-aware canonical URLs and `hreflang` relationships without making
JavaScript a requirement for navigation.

Acceptance:

- desktop and mobile navigation expose a keyboard- and screen-reader-usable
  language switcher;
- each published locale has stable URLs, localized metadata, canonical and
  `hreflang` relationships, and an explicit English fallback;
- the homepage, catalog, minimum onboarding path, security/privacy boundaries,
  and shared navigation launch together for a locale rather than as a
  misleading mixed-language shell;
- registry and internal-link validation run for every published locale; and
- translation freshness has a named owner and a check that detects source-copy
  changes requiring review.

## Explicit non-goals

- Publishing the internal `topics/` or `docs/project/` trees as-is.
- Replacing runtime server capabilities with marketing metadata.
- Advertising planned features as if they have shipped.
- Adding account, session, prompt, or product-interaction analytics.
- Adding a new analytics vendor merely to count CTA clicks.
- Promoting the desktop apps from beta to stable without a separate
  release-readiness decision.
- Publishing or linking an Android build before the Android app has an
  approved public distribution.
- Building client-side docs search before the corpus demonstrates a need.
- Adding a public-site language switcher before the localized route and
  translation-freshness contracts are ready.
- Turning the homepage into a complete reference manual.
- Rewriting dated news articles to erase historical product state.
- Deploying the website before the Maintainer asks for a release.

## Completion ledger

| Step | Product surface | Status | Evidence |
| ---: | --- | --- | --- |
| 1 | Public product-communication contract | Complete | `topics/website-product-communication.md` owns the rendered boundary and release claims. |
| 2 | Typed feature registry | Complete | `site/src/data/` validates feature, provider, distribution, and docs relationships at build time. |
| 3 | Complete feature catalog | Complete | `/features` renders 27 shipped stable/experimental capabilities plus provider and distribution status. |
| 4 | Concise homepage narrative | Complete | The homepage uses registry-selected proof, cross-device and first-party positioning, trust, install choices, and a compact FAQ. |
| 5 | Desktop downloads and platform status | Complete | macOS and Windows link to GitHub Releases as Beta; Android is development-only with no download URL and its native-value release gate explained. |
| 6 | Public docs shell | Complete | Astro content pages provide hierarchical desktop/mobile navigation, anchors, TOC, pagination, and copyable code. |
| 7 | Minimum complete user journey | Complete | Twelve guides cover install, updates, access, providers, sessions, queueing, notifications, files, security, and recovery. |
| 8 | Public claim alignment | Complete | README, FAQ, provider guide, current CTAs, spring recap, public relay history, and device-control CTA now point to current catalog/docs facts, including experimental pi support. |
| 9 | Privacy and analytics ownership | Complete | Privacy discloses Cloudflare Web Analytics and current relay/share boundaries; `/remote/` stays outside the beacon. |
| 10 | Measurement baseline | Release prerequisite | Read-only dashboard access was checked on 2026-08-01, but the available browser was signed out. Record the largest pre-release range before tagging. |
| 11 | Public-site verification | Complete | Warning-free build validator plus inspected Playwright captures at 1,920×1,080 and 375×812, including dark/light, navigation, focus, overflow, and images. |
| 12 | Release and closeout | Awaiting release | Deliberately not deployed: release only through the Maintainer-authorized `site-v*` workflow, then run the listed production smoke. |
| 13 | Public website localization | Roadmap | The app supports six languages; translated website routes and a language switcher are intentionally deferred to a dedicated follow-up. |
