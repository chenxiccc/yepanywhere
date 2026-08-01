# Website Product Communication

> The public website explains shipped Yep Anywhere behavior honestly: the
> homepage tells the product story, the feature catalog owns capability claims,
> and public docs teach supported user journeys.

Topic: website-product-communication

Related:

- [`docs/tactical/077-website-feature-catalog-and-public-docs.md`](../docs/tactical/077-website-feature-catalog-and-public-docs.md)
- [`site/src/data/features.ts`](../site/src/data/features.ts)
- [`site/src/data/providers.ts`](../site/src/data/providers.ts)
- [`site/src/data/distributions.ts`](../site/src/data/distributions.ts)

## Public surface ownership

- The homepage is selective. It states the primary outcome, local execution
  boundary, trust model, and next steps, then renders a small set of registry-
  selected feature highlights.
- `/features` is the canonical public catalog of shipped capabilities. A
  capability is included once and rendered from the feature registry.
- `/docs` is the canonical user guide. Internal topics, architecture notes,
  tactical plans, and historical proposals are evidence for authors but are
  not published as customer documentation.
- News posts remain dated history. Current calls to action should point at the
  canonical catalog or docs when a dated article's product state has moved on.
- The README stays concise and links to the public catalog/docs rather than
  maintaining another exhaustive inventory.

## Registry contract

The site has three editorial registries with distinct meanings:

- **Features** describe shipped user capabilities. `stable` means the public
  workflow is supported for its stated availability; `experimental` means it
  is shipped but may have rough edges, narrower coverage, or opt-in exposure.
- **Providers** describe the integration maturity of agent backends. A stable
  provider is expected to support the primary session, streaming, approval,
  and diff workflow. Experimental provider capabilities vary and must not
  inherit blanket parity claims.
- **Distributions** describe ways to install or access Yep Anywhere. Their
  states are `available`, `beta`, and `development`.

These registries are editorial release claims, not runtime negotiation. They
must not replace server capability gates, provider adapter contracts, or
hosted-client compatibility checks.

Every registry entry has a stable id, concise public copy, an owning docs path,
and repository source references for review. A build fails on duplicate ids,
unknown relationships, missing docs destinations, or an invalid status. A
development-only distribution must not have a download URL.

Planned features are excluded from the feature catalog. A development-only
distribution may appear in an explicit platform-availability comparison so a
visitor is not misled, but it receives no download action or installation
instructions.

## Current distribution statements

- The npm/server install and browser client are available.
- Signed macOS and Windows desktop installers are published through GitHub
  Releases and are publicly labeled **Beta** while release-readiness work
  continues.
- The Android app is in development and is not published. The normal phone
  experience is the browser client. The website must not expose an Android
  download, store badge, or installation procedure.
- Remote Android device control is a separate capability and must not be
  described as the Android client app.

## Navigation and fallback behavior

The primary public navigation exposes Features, Docs, News, GitHub, Log In, and
Get started at desktop and phone widths. Get started routes to
`/docs/getting-started`; Log In routes existing installations to `/remote/`.

A feature with no dedicated guide links to the nearest useful public docs
section. It never links to a missing route or uses an internal design document
as the sole user guide. Public pages must remain navigable without JavaScript.

## Analytics and privacy boundary

Cloudflare Web Analytics runs on the Astro marketing, news, and docs pages via
the shared base layout. It collects aggregate page/performance measurements.
The privacy page discloses that behavior.

The hosted `/remote/` application does not include the marketing analytics
beacon. Product sessions, prompts, files, approvals, and application actions
are not marketing events. Changing that boundary requires a separate explicit
privacy and product decision.

Important journeys use distinct page paths, including `/features`, `/docs`,
and `/docs/getting-started`, so aggregate path traffic can answer navigation
questions without custom event tracking. Page views are not proof that an
installation or workflow succeeded.

## Verification contract

Before a website communication change is complete:

- `pnpm site:build` succeeds without warnings;
- the built-site validator checks catalog relationships, public internal links,
  canonical metadata, and the analytics inclusion boundary;
- homepage, feature catalog, docs, navigation, and privacy are inspected at
  1920 x 1080 and 375 x 812 in a real browser;
- light and dark themes remain readable;
- keyboard focus, mobile touch targets, code overflow, and long-doc navigation
  remain operable; and
- the site changelog describes externally visible changes.
