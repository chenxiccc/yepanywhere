# Vanilla Defaults

> Out of the box, YA must feel exactly like the first-party provider UIs
> users already know; every YA-novel user-visible behavior ships
> configurable and default-off until promoted by a deliberate product
> decision.

Topic: vanilla-defaults

## Theory

YA's users arrive trained by first-party surfaces — the Claude Code TUI,
claude.ai web, the Codex CLI/app, desktop agent clients. The overarching
UX rule for all new user-visible features: a first-time user must not
have to learn, or even notice, a new concept. In the maintainer's words
(2026-06-11): "it should just be totally normal like the desktop
applications", "I don't want to have something that requires people to
think when they first use it", "the default behavior should just be
totally vanilla".

This is a rule about *defaults and onboarding*, not about ambition.
Novel features remain welcome — do not assume first-party harnesses have
already implemented every useful behavior. The constraint is only that
novelty must never be the out-of-the-box experience.

## Contract

- **Default behavior is indistinguishable from first-party
  expectations.** If a user who has only ever used the provider's own
  UI would be surprised, the behavior is YA-novel and falls under this
  contract.
- **YA-novel user-visible behavior ships configurable and default-off.**
  This applies to UI chrome, new interaction concepts, and — easy to
  miss — anything that modifies what the user submitted before it
  reaches the provider. Sent text is delivered verbatim by default,
  apart from explicitly invoked transforms (emulated slash-command
  expansion, attachment references): "when I send a message I want my
  exact message to be sent", with no YA-added framing or annotations.
- **The filesystem is also a user-visible surface.** Creating hidden state,
  growing a checkout, or changing its Git metadata is observable even when an
  exclusion keeps `git status` clean. YA-managed project storage is therefore
  novel and default-off; ordinary project/session viewing stays project-read-
  only. See [project-directory-storage](project-directory-storage.md).
- **Established-convention affordances, invisible until invoked, may
  ship always-on.** A behavior a first-party-trained user already
  recognizes from common harnesses — a shell-escape command prefix such
  as `!!`, echoing the Claude Code TUI's `!` bash mode — is not
  YA-*novel*, so the novelty test that drives default-off does not fire.
  It may ship always-on when all three hold: (1) it mirrors an
  established cross-harness convention, (2) it manifests only when the
  user deliberately types its trigger, and (3) it adds no default-visible
  UI surface. This is the same "explicitly invoked transform" logic
  carved out above (slash-command expansion), applied to a command prefix
  that *diverts* rather than annotates: a `!!` line runs locally and is
  never sent to the provider, so the verbatim-to-provider invariant is
  untouched. Any *discoverable* surface such an affordance introduces (a
  sidebar entry, a toolbar section) is itself YA-novel and still ships
  default-off.
- **Believed-useful is not proven-useful.** A plausible, even
  well-argued benefit does not earn default-on; it earns an option.
  Promotion to default-on is a product decision that should state why
  the behavior is safe and unsurprising for users who never chose it
  (see [hard-development-rules](hard-development-rules.md) for the
  configuration-precedence side of that bar).
- **Options must pay rent.** A default-off option that turns out not to
  be useful should be removed, not accumulated. The configuration
  surface is itself a user-visible cost.

Synthetic `/done` is a direct instance of this rule. Its toolbar presence
defaults to Off, so an agent or installed skill named `/done` continues to
receive the user's text. Opting into Hidden enables YA's local command without
adding chrome; visible narrowing tiers also show its toolbar button.

## Known Exceptions

The server-wide **Subagent nesting limit** defaults to depth `1`, rather than
Claude Code's first-party default of `3`. Native subagent fan-out can multiply
token and quota use before an operator can see or stop the deeper work, so this
configurable resource guard intentionally starts safer. `0` disables subagents,
`1` through `4` select an explicit maximum depth, and **Provider default** makes
YA inject no override. An explicit Claude depth value in YA's environment still
wins. The control identifies its actual provider coverage and applies only to
newly started or resumed processes; it never mutates provider configuration
files. Authorized by graehl on 2026-08-16 as a deliberate quota-protection
exception. See [claude](claude.md) and [codex-sessions](codex-sessions.md).

[source-review-to-session](source-review-to-session.md) defaults review
history and outcome visibility on for new installs. A review is already an
explicit user action; the default makes its submitted history and eventual
agent response discoverable in Source Control and Inbox. With no submitted
review, it performs no response-observation work. The setting remains
available, explicit stored false remains authoritative, and old stored false
values are not migrated because they cannot be distinguished from an earlier
untouched default. Authorized by graehl on 2026-08-11.

[composer-full-pane-editing](composer-full-pane-editing.md) adds a visible
full-pane toggle to the New Session, editable handoff, and in-session
composers. The in-session top-right control remains available in the one-line
composer and is currently a live placement prototype. Authorized by graehl on
2026-08-08 for New Session and handoff, then extended on 2026-08-09 to the
in-session composer because the mode remains entirely user-invoked; ordinary
composer behavior and draft submission are unchanged until the user enters it.

[tooltip-interactions](tooltip-interactions.md) Themed tooltips ship default-on
for browsers without an explicit saved mode. Explicit Native and Themed choices
remain authoritative. Authorized by graehl on 2026-08-04 after the
pointer-generated touch-focus reopen defect that motivated the temporary Native
default was fixed; the shared layer now provides fast scanning, selectable text,
and readable glossary definitions without changing control activation.

**`!!` bang commands** ([bang-commands](bang-commands.md); recall drawer
in [composer-recall-drawer](composer-recall-drawer.md)) run a local shell
command from the composer instead of sending the line to the provider.
Under the established-convention carve-out above — shell-escape is
familiar (Claude Code `!` bash mode), the `!!` prefix is typed
deliberately, and provider-bound text is untouched — bang *execution* and
the Ctrl+Up recall drawer ship always-on; only the discoverable "!!
Commands" sidebar section stays default-off. Authorized by graehl
(2026-07-25) as an explicit amendment reversing an earlier default-off
decision, and canonized here (and in the commit) for kzahel's review
given the default-disabled preference ([kzahel-disabled](kzahel-disabled.md)).

[prompt-cache-keepalive](prompt-cache-keepalive.md) is a deliberate
default-on exception for active-enough live clients, but only where a provider
exposes a no-context-move refresh path. The default must not create visible
session rows, future-visible provider context, or autonomous server upkeep for
sessions with no current client viewer; stronger hidden-message keepalive modes
remain explicit per-provider choices.

[conversation-view](conversation-view.md) and its Session Toolbar control ship
default-on. The condensed projection keeps user/agent conversation, media, and
important failures visible while preserving one-click access to every routine
activity in original order. This was approved by graehl on 2026-07-28,
relaying Kyle's chat approval, because the resulting default matches the
condensed conversation presentation users already encounter in the Codex and
Claude harnesses. Existing browser-local mode and toolbar-presence choices
remain authoritative.

[mic-button-speech-ui](mic-button-speech-ui.md) ships the configurable live
microphone waveform default-on, with toolbar-button backgrounds at 70% opacity
over it by default. It appears only during an explicit YA-controlled microphone
capture, uses real audio samples, and changes no submitted text or provider
behavior; browser-native Web Speech receives no fabricated waveform. Users may
hide it or set button backgrounds anywhere from fully transparent to fully
opaque. Authorized by graehl on 2026-08-11 so microphone feedback is
discoverable without requiring users to predict the useful opacity first.

[media-rendering-and-routing](media-rendering-and-routing.md) compact
multi-image galleries ship default-on as a browser-local Appearance preference.
For an assistant turn with at least two eligible images, the preference enables
one turn gallery while preserving every original text link and full-size target.
**Expand Inline Media by Default** controls only whether that gallery starts
open. When inline expansion is off, a compact **Gallery** action beside the
final image link makes the capability available without expanding content. It
is a stateful **+ Gallery** / **− Gallery** toggle, while each image's own
`+` / `−` toggles the same gallery centered on that image. Image links retain
their conventional direct-view behavior without changing inline gallery state.
Disabling the gallery preference removes the action and restores independent
inline previews. Authorized by graehl on 2026-07-29 because the default bounds
an already-requested automatic presentation, adds only a contextual action on
multi-image turns otherwise, and avoids burdening new users with another
preference.

[agents-process-observability](agents-process-observability.md) ships
default-on in the existing Agents view. Sampling is request-driven and occurs
only while that view is open and visible; a Performance setting disables it,
and a user can also avoid the work simply by not opening Agents. The browser
receives only normalized provider identity, PID, start/sample times, recent
CPU, and RSS/process-tree counts—never command lines, environment, executable
paths, or working directories. Authorized by graehl on 2026-07-28 as an
explicit product decision: Agents is already the process-inventory surface,
and standard process metrics plus independently launched agent processes make
that purpose useful without changing session or provider behavior elsewhere.

[steer-queue-provider-differences](steer-queue-provider-differences.md)
promotes Claude's existing **Steer now** preference to default-on when no stored
preference exists. An explicit false remains authoritative and restores the
`next` lane. Authorized by graehl on 2026-08-08 after live Claude 2.1.223 probes
showed that `now` stayed queued behind a foreground Bash command without
interrupting or backgrounding it, while a second correction delivered 112 ms
after the first boundary correction prevented the first correction's proposed
tool call. The behavior reduces the correction race but does not make separately
submitted steers atomic; the provider can still launch a tool before a later
message arrives. Transparency for non-Bash tools remains unverified.

The same topic defaults Claude foreground-Bash re-entry on for all main-turn
commands, configurable through the server's whole-command allow/deny expressions.
Authorized by graehl on 2026-08-08 after exact-ID SDK probes showed that Bash
continued to completion while Claude received the already-enqueued correction and
no forbidden follow-on command launched. This does not interrupt the command, but
it lets Claude act concurrently with it; operators can deny expensive,
side-effecting, or lock-holding commands. Other tool types, subagent-owned Bash,
and the SDK's all-task background control remain excluded.

[mic-button-speech-ui](mic-button-speech-ui.md) treats conservative
mid-sentence capitalization smoothing as built-in speech-input behavior, with
no preference. Some recognizers title-case every finalized phrase after a
pause; YA lowercases only an allowlist of ordinary continuation words on a
second or later chunk in the same mic transaction. Sentence starts, provider
revisions, acronyms, single letters, and unlisted title-case words remain
provider-verbatim. Authorized by Kyle on 2026-07-30 as an explicit product
decision after observing the pause-boundary behavior interactively.

## Worked instance: default-off speech annotations

[mic-button-speech-ui](mic-button-speech-ui.md) offers a browser-local
**Speech message prefix** selector with `[ASR]`, `[STT]`, `[Dictation]`, and
Custom choices. The selector defaults to Off, so Smart Turn, spoken `send`, and
manual delivery all remain provider-verbatim until the user opts into this YA-
novel annotation. An optional Quick-send window extends the selected prefix to
one rapid manual delivery after finalized speech; it also defaults to 0/off and
has no effect while prefixing is Off. This is an ordinary application of the
provider-text rule above, not a Known Exception.

## Worked instances: queued-turn delivery

[compose-time-context-anchors](compose-time-context-anchors.md)
prepended `(Ns ago)` / `(Ms later)` staleness markers to queued turns at
delivery, so an agent would not misread a stale queued comment as
referring to its most recent output. The benefit was believed but
untested, and the mechanism rewrote provider input — the provider saw
text the user did not type. Upstream removed it outright
(`25e7f5d1`, "Keep queued messages verbatim"). The resolution under this
theory and [kzahel-disabled](kzahel-disabled.md): preserved behind
`YEP_COMPOSE_ANCHORS=1`, default off.

Batched deferred flush is the sibling instance: merging several queued
turns into one `--------`-joined provider turn defeated the upstream
usage of queueing N "good, proceed" messages to buy N work slices, and
was claimed to differ from first-party queue delivery. Default is now
one verbatim deferred turn per delivery boundary; joining is preserved
behind a configurable compose-time join window
(`deferredJoinWindowSeconds` server setting / `YEP_DEFERRED_JOIN_WINDOW_S`,
0 = never join). The blind-go-ahead intent itself deserves a first-class
control someday (a slice or duration budget), rather than riding on
queue mechanics.

## Related topics

- [hard-development-rules](hard-development-rules.md) — explicit user
  configuration is authoritative; trust-sensitive defaults need opt-in
  or migration paths.
- [kzahel-disabled](kzahel-disabled.md) — upstream disablement of a
  speculative feature is a product signal; prefer configurable
  default-off preservation over silent code stripping, with the
  maintainer choosing the resolution.
- [session-ui-customization](session-ui-customization.md) — the
  visibility/enablement configuration surface that default-off UI
  features typically live behind.
