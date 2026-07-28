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
capabilities may decide whether a choice has an effect at launch, but the UI
should not hide or rewrite the user's standing preference merely because the
currently selected provider lacks the feature.

- **Default AI provider** — the provider chosen when opening a new-session form.
  The floating composer's informational chip resolves this plus the provider's
  preferred model through `useDefaultNewSessionModel`, which must keep matching
  the New Session form's initial seeding (same `getProviderSessionDefaults` and
  preferred-model pick).
- **Permission mode** — the requested approval policy. A model may hide or
  ignore unsupported modes such as provider-decided `Auto`, but the saved
  default is not a provider/model economics choice.
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
pick should survive as a per-session choice, not silently reset or leak to every
other session. This is the same contract [permission-mode](permission-mode.md)
already meets — a per-session UI choice persisted in `localStorage`
(`permission-mode-{sessionId}` in `useSession`) so a reload restores it instead
of dropping to `default`.

- **Model — per session (as of this note).** A session's model pick persists to
  `localStorage` keyed by session id (`session-model-{sessionId}`,
  `lib/sessionModelStorage.ts`), saved in `useSession`'s `setSessionModel` and
  restored on load for an idle (non-self-owned) session. This closes the gap
  where a model change — which only reaches the server at the next turn — was
  lost if the tab closed before sending. A live self-owned process's model stays
  authoritative (its config arrives via the stream); the stored pick only
  overlays when idle.

- **Effort / thinking mode — still global, and that seems unintended.** Unlike
  model and permission mode, effort level and thinking mode persist only
  *globally* via `useModelSettings` (`BROWSER_LOCAL_KEYS.thinkingLevel` /
  `.thinkingMode`). Changing effort inside one session therefore rewrites the
  effort used by *every* session, and reopening a session shows the global value
  rather than what was last chosen for that session. The idle `ModelSwitchModal`
  reads these same global values (`getEffortLevel()` / `getThinkingMode()`), and
  `applyConfig` writes them back globally (`setEffortLevel` / `setThinkingMode`).

  **Intent:** make effort and thinking-mode changes per-session too, mirroring
  the model/permission-mode persistence above (a `session-effort-{sessionId}` /
  `session-thinking-{sessionId}` pair, or a single per-session config record),
  so a live pick sticks to its own session instead of the whole browser. Keep
  **show-thinking** display policy all-provider/per-install (it is a render
  preference, not a spend control) — only effort and thinking *mode* move
  per-session. The global values become the seed for a session's first pick,
  preserving today's behavior for sessions the user never touches. This is
  deferred, not yet built; the model change is the first step of the pattern.

## UI placement

In the session-defaults panel and the new-session form:

1. All-provider defaults: recaps; prompt suggestions; permission mode;
   show-thinking display policy; and forked-session behavior.
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
