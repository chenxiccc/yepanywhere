# Provider Subscription Usage

> Provider subscription usage is YA's normalized, read-only view of provider
> account rate-limit windows, combining provider-wide and model-scoped quotas
> without treating session token accounting as subscription capacity.

Topic: provider-subscription-usage

Related topics: [provider refresh](provider-refresh.md),
[provider abstraction](provider-abstraction.md),
[server capabilities](server-capabilities.md), and
[provider context economics](provider-context-economics.md).

## Observable contract

- A usage read never creates a provider turn or persisted provider session.
  Claude uses the Agent SDK's read-only control query; Codex uses app-server
  `account/rateLimits/read`. YA does not scrape provider web pages, invoke a
  slash command, or infer account capacity from local transcript token totals.
- The server returns `ProviderSubscriptionUsage | null`. Each normalized window
  carries percent used, optional duration/reset time, and either provider-wide
  scope or an explicit set of YA model ids. Provider-specific response fields
  do not cross the server provider boundary.
- A model's compact value is the maximum percent used among every applicable
  provider-wide and model-scoped window. This is the binding quota: highest
  utilization, equivalently the smallest remaining capacity. The detail view
  shows every applicable window.
- Unknown model-specific buckets are omitted rather than applied to every
  model. Accounts or auth modes without subscription quotas, unsupported
  providers, and failed upstream reads return null and add no usage UI.
- Usage is demand-fetched, cached briefly per source and provider on both sides
  of the client/server boundary, and explicitly refreshable from the detail
  view.

## Client surfaces

The compact binding percentage appears beside model choices in New Session,
Model Settings, live Model Switch, and Handoff Session. The session context
indicator has two distinct interactions:

- left click, Enter, or Space opens all applicable subscription windows and
  reset times when usage is available;
- right click or touch long-press opens the existing per-model compact-threshold
  editor. The usage detail also links to that editor so it remains keyboard
  accessible.

The existing context percentage remains context-window consumption, not
subscription usage.

## Compatibility

`provider-subscription-usage` is a transitional server capability covering
`GET /api/providers/:name/subscription-usage`. A client must observe the
capability before making the request. Without it, the client makes no
unsupported request, shows no subscription-usage badges or detail, and
preserves the passive context tooltip plus compact-threshold interaction.

The implementation was reviewed against stable releases `v0.7.0` and
`v0.6.2`, neither of which has the capability or route. This narrow optional
feature does not raise `remoteCompatibilityLevel`.

## Provider boundaries

Claude Agent SDK `0.3.220` marks its subscription-usage control method
experimental. `ClaudeProvider` contains that instability: the normalizer
accepts only the fields YA needs and any unavailable or changed response
degrades to null.

Codex CLI `0.145.0` exposes single- and multi-bucket rate-limit snapshots.
The general `codex` bucket is provider-wide; named buckets are model-scoped
only when their provider label resolves to a current catalog model. Existing
`account/rateLimits/updated` events remain non-terminal telemetry and never
become synthetic turn errors.
