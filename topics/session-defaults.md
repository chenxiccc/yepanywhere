# Session Defaults

> Session defaults are the standing choices used to seed new YA sessions;
> some apply across all providers, while provider/model economics controls
> must be stored per provider rather than shared as one global value.

Topic: session-defaults

See also: [permission-mode](permission-mode.md) for the `Auto` permission-mode
fallback contract when a selected model cannot honor provider-decided approval.

## Contract

Session defaults are not one flat bucket. A default either answers "what should
new sessions generally do?" or "how should this provider/model spend work?".
Those scopes must stay separate in storage, UI grouping, and migration.

### All-provider defaults

All-provider defaults apply no matter which provider is selected. Provider
capabilities may decide whether a choice has an effect at launch. Except for a
security boundary whose current execution host cannot enforce, the UI should
not hide or rewrite the user's standing preference merely because the
currently selected provider lacks the feature.

- **Default AI provider** — the provider chosen when opening a new-session form.
  The floating composer's informational chip resolves this plus the provider's
  preferred model through `useDefaultNewSessionModel`, which must keep matching
  the New Session form's initial seeding (same `getProviderSessionDefaults` and
  preferred-model pick).
- **Permission mode** — the requested approval policy. A model may hide or
  ignore unsupported modes such as provider-decided `Auto`, but the saved
  default is not a provider/model economics choice.
- **Sandbox new sessions** — the default-off launch-time host-confinement
  toggle. The saved value is provider-independent and each New Session may
  override it before process creation. The control is rendered and sent only
  when the server reports a currently available host backend; see
  [session-sandboxing](session-sandboxing.md).
- **Recaps** — recap mode and away threshold belong together. They are
  presented above AI Provider because they are standing session-helper choices,
  not properties of whichever provider button happens to be selected.
- **Prompt suggestions** — expose `Off` / `Native` unconditionally. Launch code
  only enables native provider suggestions when supported, but the default UI
  must not show provider-specific "unsupported" copy in the all-provider area.
- **Show thinking** — display policy for already-produced thinking rows. This
  is not provider spend; it belongs outside the AI-provider-specific region and
  may keep the existing per-install/live-toggle persistence pattern.
- **Forked sessions** — fork-after-summary display/opening behavior, such as
  whether to open the forked session in a new tab when ready. This is a
  session-UI preference, not a provider/model economics choice.

### Provider-specific defaults

Provider-specific defaults depend on provider/model capabilities, cost, latency,
and naming. They must be keyed by provider, and model-sensitive values should be
resolved against that provider's available model metadata.

- **Model** — model ids are provider-local and cannot be shared across providers.
- **Service tier / speed tier** — provider-visible economics and latency knobs.
- **Thinking mode** — `off` / `auto` / `on` changes provider work requested.
- **Effort level** — effort labels are not comparable across providers; `high`
  on one backend is not a portable meaning or cost on another.
- **Tailed Recap Model** — tailed recap model ids, costs, and availability are
  provider-local. The selector is intentionally lower-priority than thinking
  mode and effort. OpenAI-compatible helper targets stay hidden until
  [openai-compatible-helper-sessions](openai-compatible-helper-sessions.md)
  exists.

Switching AI Provider should restore that provider's provider-specific defaults
without disturbing all-provider defaults. Changing an all-provider default should
not overwrite per-provider model/thinking/effort choices.

### Provider catalog readiness

The first authenticated or remotely connected YA visit in a browser tab primes
provider status and model catalogs through the same source-scoped request/cache
used by New Session, settings, and restart surfaces. A consumer mounted during
that primer joins its in-flight request rather than repeating provider probes.
Catalogs and in-flight work from one local or remote host must never satisfy a
consumer viewing another host. Primer failure remains advisory: the first
consumer retries through its normal loading/error path.

Readiness is client-presence-driven. YA does not periodically probe provider
catalogs while no browser is visiting it; the existing bounded client and server
cache lifetimes govern freshness during active use, and explicit refresh actions
retain their stronger semantics. When a primer overlaps a later explicit
refresh or reload for the same source, only the later request may update the
shared cache or mounted consumer state, regardless of response order.

The standing provider/model choice is durable settings state, not a dynamic
catalog answer. New Session must render the exact saved provider and
provider-local model identity in its final control region from the retained
settings snapshot, then revalidate installation, authentication, alternatives,
and model capabilities in place. An unselected provider's discovery must not
delay, clear, or replace that choice. The opening composer/project region stays
stable while catalog rows activate.

Two mechanisms carry that requirement today. The selected provider's status and
models come from its own single-provider request rather than the aggregate, so
the aggregate's slowest member cannot gate the selection; the server coalesces
that request with any aggregate already probing the provider, so it costs no
extra probe. And a client may render the previous visit's provider rows from a
retained per-source snapshot, which is an opening guess and never a probe
result: it arrives already expired, consumers still report loading, the rendered
group is marked busy, and the probe's answer replaces it. A row shown this way
may name a provider the server no longer exposes until the probe corrects it;
selecting it is still checked at launch.

The server retains a bounded, non-secret last-successful model snapshot per
provider across restarts. A stale snapshot may render choices but does not
prove current authentication or launch validity. Do not persist credentials,
raw provider command output, user identity, or arbitrary configuration text in
that snapshot. Provider configuration changes make the snapshot stale and
schedule provider-local revalidation; errors retain the stale rows with an
explicit retry rather than making every provider unavailable.

Generic catalog discovery is side-effect-free with respect to provider
runtimes. It must not start or retain a configured Gateway or other provider
service merely because a tab opened. Selected-provider refresh and launch may
perform the provider-specific readiness work their contracts require.

Selecting a configured provider whose model list is authoritative but dynamic
triggers a background explicit refresh, even when a cached empty catalog made
the provider eligible to select. The current provider list remains visible
while that refresh runs. When Claude Gateway still advertises no models, New
Session shows a retryable unavailable state and blocks fresh launch instead of
submitting without a model. When models arrive, the selection reconciles to a
provider-scoped saved model or the first advertised row and capability-driven
controls appear. An exact saved model that is absent from an authoritative
Gateway catalog is neither displayed nor submitted; this applies equally to
the New Session picker and its informational floating-composer badge. Providers
whose contracts permit exact unlisted ids retain their existing behavior.

Refresh is provider-local. Selecting or retrying Gateway must not force model
and authentication probes for Codex, OpenCode, Pi, or any other unrelated
provider. Supplementary subscription/usage telemetry activates after the
selected controls are interactive or on direct demand and updates in place; it
is not part of provider/model readiness.

The implementation handoff is
[`docs/tactical/094-new-session-provider-catalog-readiness.md`](../docs/tactical/094-new-session-provider-catalog-readiness.md).

## Recap fallback semantics

`Forked` is a preference for the higher-fidelity recap path. **Tailed Recap
Model** is the provider-scoped helper model for the tailed path, so it is shown
with provider-specific defaults when `Tailed` is selected and hidden for `Off`,
`Native`, and `Forked`.

`Native` remains a valid internal/future recap mode, but no current backend
offers a meaningful way to request native recaps. Do not show it in the UI until
a provider capability makes it real.

## Per-session live picks vs global defaults

The rest of this doc is about *defaults that seed a new session*. A separate
concern is what happens when a user changes model/effort/thinking **inside an
existing session** and then reloads or the server process is torn down: the live
pick must survive as a server-owned per-session choice, not silently reset or
depend on one browser's storage.

`SessionMetadata.effectiveLaunchSettings` stores the last successfully applied
permission mode, exact requested-model token, service tier, thinking mode, and
effort with a session-local monotonic revision. A process lifetime is not a
settings lifetime: every replacement process for an existing session starts
from that record. A replacement process resolves
an explicit validated request first, then this durable record, then applicable
legacy model metadata, and finally the conservative server/provider default.
Legacy absence never grants Bypass.

Browser-local permission/model state remains useful for immediate stopped-row
presentation and compatibility with older servers, while global thinking and
effort values remain defaults for new or legacy sessions. Once Activate owns a
process, the existing process-info request and live stream are authoritative;
the composer and model panel adopt that process's restored configuration. An
older server that omits newer state therefore retains its established fallback
instead of causing the client to clear durable server state.

**Show thinking** remains a browser display preference. It is deliberately not
part of the provider launch snapshot and does not move with a session.

## UI placement

In the session-defaults panel and the new-session form:

1. All-provider defaults: recaps; prompt suggestions; permission mode; the
   sandbox-new-sessions toggle; show-thinking display policy; and
   forked-session behavior.
2. AI Provider. The selector is the boundary between all-provider defaults above
   and provider-specific defaults below.
3. Provider-specific defaults for the selected provider: model, service tier,
   thinking mode, effort, **Tailed Recap Model**, prompt-cache keepalive,
   compaction threshold, and other model economics controls.

Permission-mode cards are equal-sized by design. Their captions should fit the
card grid with short explanatory text:

- `Ask` — `Ask every time`
- `Edit` — `Ask to run commands`
- `Plan` — `Do not attempt edits`
- `Bypass` — `Auto-approve all actions`
- `Auto` — `Provider decides`

## Storage and migration direction

Use a shape that preserves existing top-level fields while adding a scoped
provider-default map, for example:

```ts
interface NewSessionDefaults {
  provider?: ProviderName;
  permissionMode?: PermissionMode;
  sandboxLevel?: SessionSandboxLevel;
  recapMode?: RecapMode;
  recapAfterSeconds?: number;
  promptSuggestionMode?: PromptSuggestionMode;
  providers?: Partial<Record<ProviderName, ProviderSessionDefaults>>;
}

interface ProviderSessionDefaults {
  model?: string;
  serviceTier?: string;
  thinkingMode?: ThinkingMode;
  effortLevel?: EffortLevel;
  helperSideModel?: string;
}
```

Backward compatibility rule: top-level legacy `model` / service-tier-like
fields, and legacy `useModelSettings` thinking/effort values, seed the selected
provider's first provider-specific entry. Do not discard configured values on
read; normalize into the scoped shape on the next save.

## Implementation plan

Session sandboxing follows the separate backend-integration gate in
[session-sandboxing](session-sandboxing.md); it is not part of the
UI/storage sequence below.

1. **Pin this contract.** Create this topic, add the glossary/topic index row,
   and use it as the commit topic for the UI/storage changes.
2. **Recap UI.** Move recap controls above AI Provider; keep **Tailed Recap
   Model** in provider-specific defaults after thinking effort; make `Forked`
   available whenever the provider can generate recaps.
3. **Prompt suggestions.** Show `Off` / `Native` unconditionally in the
   all-provider defaults area; remove provider-specific unsupported copy; keep
   launch-time native enablement capability-gated.
4. **Provider-specific defaults.** Add `newSessionDefaults.providers` and wire
   selected-provider model, thinking mode, effort, and tailed recap model
   through it. Preserve legacy fields and existing saved preferences by seeding
   the selected provider on read/next save.
5. **All-provider placement.** Move permission mode, show-thinking display
   policy, and forked-session behavior out of the AI-provider-specific region.
   Keep show-thinking all-provider/per-install and separate from thinking mode +
   effort spend controls.
6. **Permission captions.** Shorten equal-width permission-mode card captions to
   the text above.
7. **Tests.** Cover provider switch persistence, all-provider recap/suggestion
   persistence, fork-to-tailed fallback, and the new ordering/label invariants in
   focused client/server tests before typecheck.
8. **Layout verification.** Verify the defaults panel is efficient and sensible
   in a modest 1200×1000 options content area: the core defaults should be
   usable without unnecessary scrolling, with recap/suggestion/provider/model/
   thinking/permission controls packed by their scope rather than stretched into
   a long vertical list.
