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

## Known Exceptions

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

[media-rendering-and-routing](media-rendering-and-routing.md) compact
multi-image galleries ship default-on as a browser-local Appearance preference.
They apply only when **Expand Inline Media by Default** is already enabled and
an assistant turn has at least two eligible images, replacing an unbounded
vertical stack with one bounded gallery while preserving every original text
link and full-size target. Disabling the gallery preference restores independent
inline previews. Authorized by graehl on 2026-07-29 because the default bounds
an already-requested automatic presentation rather than revealing more content
or changing provider behavior.

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
