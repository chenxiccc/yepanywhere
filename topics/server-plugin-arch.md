# Server Plugin Arch

> Banked: a server-code plugin architecture — optionally loaded code gated by
> a settings toggle — is a deliberate no for now; monolith convenience wins,
> a stable plugin API would be a maintenance headache with no current
> benefit, and only a real contributing community would reopen the question.

Topic: server-plugin-arch

Status: **banked, decided against (2026-07-24).** Seed from the kzahel chat,
captured so the reasoning is findable when the question recurs.

## The position

The idea: server code optionally loaded at runtime, gated by settings that
enable each plugin. The verdict from the chat: "a big no" for the current
project shape, because:

- **Monolith convenience is a positive value.** One codebase, one deploy,
  no version-compatibility matrix, refactors can touch anything freely.
- **A plugin surface demands a stable API.** Exposing load points means
  cleaning up internal APIs, marking which parts are stable, and honoring
  that marking forever after — a big headache purchased for no benefit at
  the current user count.
- **The reopen condition is a community.** If there were a community
  contributing such things, that is another question; until contributors
  exist, the cost is all downside.

## Relations

- [[core-service-api]] is adjacent but different: it exposes the runtime
  *outward* as a service/extractable library, rather than loading foreign
  code *inward*. If it ever lands, its cleaned API boundary would be the
  natural attachment point a plugin surface could reuse — a sequencing fact,
  not a reason to build plugins.
- [[interactives]] shows the preferred alternative shape for extensibility:
  independent out-of-process apps reached by proxy under a convention, with
  no code loaded into the YA server and no stable internal API exposed. The
  browser-facing proxy must still satisfy [[active-content-security]];
  process separation does not create origin isolation.
- [[vanilla-defaults]] — a settings-gated plugin toggle would satisfy the
  letter of default-off, but the objection here is the API/maintenance cost,
  which gating does not reduce.
