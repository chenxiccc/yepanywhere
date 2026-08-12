# Prompt Suggestions

> Prompt suggestions are predicted next-user-turn affordances surfaced in the
> composer without becoming provider transcript turns unless the user accepts
> one.

This topic covers YA's next-turn suggestion surface. Claude exposes the
capability natively through the SDK's `promptSuggestions` initialization
option. YA leaves that provider-owned generator off unless a caller explicitly
opts in through provider session options. If the provider emits a
`prompt_suggestion`, the client intercepts it and renders the suggestion in the
composer rather than the message list.

## Contracts

- Prompt suggestions are suggestions, not queued turns. YA must not send one to
  the provider until the user explicitly accepts or edits it.
- Native provider suggestions and YA-simulated suggestions share the same UI
  shape: a composer affordance the user can accept, edit, or dismiss.
- A `Native` surface choice means YA expects and renders provider suggestion
  messages. It does not enable the provider's generator. Provider-owned
  suggestion generation consumes provider work, so its separate session option
  defaults off and requires explicit opt-in.
- Native suggestions do not require a side model. Simulated suggestions for
  providers without native support must use
  [side-session-config.md](side-session-config.md) for opt-in defaults, side
  model selection, bounded context, timeout, and cleanup. The side model is
  the parent session's shared helper setting, not a prompt-suggestion-specific
  model choice.
- A suggestion is tied to the current visible session state. New user input,
  session switch, focus on an aside, or provider progress that invalidates the
  predicted next turn should clear stale suggestions rather than presenting
  them as still-current.
- Suggestion output is not transcript state. Dismissing a suggestion should not
  mutate provider history, and accepting one should behave like normal user
  composer input.

## Invariants

- The client intercepts `prompt_suggestion` messages and keeps them out of the
  message list.
- Suggestions must not appear while the composer is already non-empty unless
  the UI makes the replacement/append behavior explicit.
- A simulated suggestion request must not run during active-turn steering in a
  way that competes with the user's live input path.
- Provider-specific wording or hints in a native suggestion message must not
  leak CLI-only settings into YA UI.

## Relationship to Recaps

Recaps and prompt suggestions differ in direction: a recap summarizes what the
agent already did while the user was away, while a prompt suggestion predicts
what the user might ask next. The configuration gap is the same for providers
without native support: both require a side query over bounded recent context,
both need the same shared side session, and both must remain out of the parent
transcript.

Claude currently exposes native prompt suggestions but not SDK-native recaps in
the same `--print --output-format stream-json` path. A caller can explicitly
request Claude's suggestion generator through provider session options; Claude
recaps remain a simulated-helper feature until the SDK exposes native away
summaries.

Default policy: provider-native, emulated, and YA-simulated suggestion
generators all default off. Observation remains cheap: when `Native` is
selected, YA may surface a suggestion the harness emits independently.

Current implementation note: new-session launch, provider defaults, and handoff
all expose the `Off` / `Native` observation choice as a standing all-provider
preference. `Native` affects the live process's handling of provider messages
but is not passed as `sessionOptions.promptSuggestions`. Handoff carries that
live observation preference when known, so an explicitly disabled session
stays disabled in the replacement session. The provider interface separately
accepts session-option changes and reports whether they were applied, require a
restart, are unsupported, are inactive, or remain unknown; there is not yet a
user-facing control that requests provider suggestion generation.

## Simulated Suggestions Gap

YA does not yet implement simulated prompt suggestions for providers without
native support. For those providers, `Native` in session defaults remains only
an observation preference; it must not imply or run a hidden emulation path.

Preferred future shape remains provider-native prediction if an API exposes it,
ideally by asking the provider to continue from a start-user-turn boundary and
return likely user text without appending it to transcript state. No current
provider API has been verified to expose that exact primitive.

Fallback designs are plausible, and all must use
[side-session-config.md](side-session-config.md) rather than a
prompt-suggestion-specific model choice:

- **Operator-run token predictor.** For regular, frivolous suggestion work,
  a YA operator may configure a weaker open-weight helper model served through
  vLLM or another local/remote inference server. The request should be framed
  as low-deliberation next-user-turn token prediction, not as a reasoned agent
  task: no hidden thinking, no tool use, and no transcript mutation. Lower
  model quality is acceptable because the suggestion is disposable and must be
  accepted or edited before it becomes user input. This path is still a
  simulated helper backend and should lose to a provider API that can natively
  predict user-turn tokens from a start-user-turn boundary.
- **Inline main-session tag.** Add an instruction to the parent session that,
  when it is coming to rest and has an appropriate suggested next turn, it may
  emit a specially tagged `<suggestion>...</suggestion>` block. YA would strip
  and surface the tag as composer suggestion UI. This is simple, but it spends
  parent-session context and risks contaminating normal assistant output.
- **Shared helper side session.** After an assistant turn ends, synchronize the
  shared helper side session after a brief inactivity timer, then ask it for a
  next-user-turn suggestion only when a useful default seems available. This
  keeps suggestions out of the parent transcript and matches recap-side-query
  lifecycle rules, but pays catch-up and helper-session latency.

## Tests That Should Fail On Contract Regressions

- A `prompt_suggestion` SDK message updates the composer suggestion state and
  does not render as a normal transcript row.
- Dismissing a suggestion removes it without queueing a user message.
- Accepting a suggestion follows the same send path as typed composer text.
- A simulated suggestion request for a non-native provider is disabled by
  default unless session/provider settings opt in through side-session
  configuration.
- A simulated suggestion can use a provider-qualified helper model from a
  different provider or operator-run backend without changing the parent
  session's provider/model.
