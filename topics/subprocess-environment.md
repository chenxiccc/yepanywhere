# Subprocess Environment Boundaries

> Environment behavior crosses several independent boundaries: the shell that
> starts YA, YA startup normalization, runtime config, provider-specific child
> filtering, subprocess stdio, and shell startup files. Tests must control each
> boundary they depend on.

Topic: subprocess-environment

This topic is the cross-cutting contract for environment propagation and
environment-dependent subprocess tests. The catalog and naming rules for
individual YA variables remain in [ya-env-vars.md](ya-env-vars.md).

## Runtime contracts

- Treat `process.env` as ambient input, not a stable default. A developer shell,
  package runner, service manager, or parent agent may contribute variables
  that are absent in CI or a production service.
- Normalize legacy YA aliases once at startup. Canonical values win, aliases
  are removed, and downstream code should observe only canonical names.
- Consume-and-strip YA-private module variables before launching providers.
  Provider-specific child builders may then filter, retain, or inject values
  according to that provider's contract.
- An environment overlay such as `{ ...process.env, ...overrides }` can replace
  a value but cannot express removal. A child launcher that must block an
  inherited name needs an explicit filter or denylist after merging.
- Do not broaden shared child-environment filters merely because one provider
  or subsystem must exclude a variable. Ambient credentials and tool settings
  can be part of another provider's expected behavior; exclusions belong at
  the narrowest boundary with a documented reason.
- Environment is copied at process creation. Updating YA's environment or a
  server setting does not mutate an already-running provider process. Dynamic
  data needed by later grandchildren requires a provider-supported control
  channel or an explicit bridge such as the local `agentctl` `BASH_ENV` file.

## Shell-startup contracts

- `BASH_ENV` is a Bash startup mechanism, not generic child-process
  inheritance. It is evaluated by an ordinary non-interactive Bash invocation;
  other shells and direct executable launches do not source it.
- Bash may select a remote-shell startup path when its stdin looks
  socket-backed. On affected Bash builds that path reads `.bashrc` instead of
  `BASH_ENV`. Test runners commonly use pipes or Unix sockets internally, so a
  shell probe that inherits the runner's fd topology can test a different
  startup path than the provider launch it is meant to model.
- Tests that prove ordinary non-interactive `BASH_ENV` behavior must choose
  stdio explicitly. Use ignored stdin and captured stdout/stderr
  (`stdio: ["ignore", "pipe", "pipe"]`) unless the production boundary being
  tested intentionally supplies different stdin.
- A fake provider or nested shell is evidence for production only when its
  relevant environment and stdio topology match the real launcher. Make those
  choices visible at the spawn site rather than relying on Node or test-runner
  defaults.
- The local `agentctl` bridge preserves an existing `BASH_ENV` through
  `YEP_ORIGINAL_BASH_ENV`, then sources YA's atomically updated session-env
  file. That file publishes `AGENTCTL_SESSION_ID` plus session-scoped outputs
  such as `YEP_SESSION_WAKE_URL` and `YEP_SESSION_WAKE_TOKEN`. Tests must cover
  chaining, quoting, and initially known resume ids without depending on the
  developer's own bridge.

## Hermetic-test contracts

- Server unit tests start from built-in config defaults.
  `packages/server/test/setup/hermetic-env.ts` removes every static
  `process.env` name read by `config.ts`; the AST guard in
  `packages/server/test/config.test.ts` must fail when that scrub list drifts.
- That config guard covers only direct static reads in `config.ts`. Tests for
  provider bridges, shell startup, or other modules must also remove their own
  relevant ambient variables and supply every intentional value explicitly.
- Prefer `vi.stubEnv(...)` for a test-specific process variable so Vitest can
  restore it. For subprocess tests, construct a dedicated child environment
  and scrub conflicting inherited names before applying the values under test.
- `HOME` belongs to the safe-home test launcher, and deliberate harness gates
  such as real-SDK opt-ins remain under their owning test scripts. Do not add
  either category to the general config scrub list.
- Hermeticity includes descriptors and working directory when behavior depends
  on them; a clean environment object alone is not sufficient.

## Tests that should fail on contract regressions

- A newly added direct `config.ts` environment read is absent from the unit-test
  scrub list.
- A developer-exported YA config value changes a test that expects built-in
  defaults.
- An inherited `BASH_ENV`, `YEP_ORIGINAL_BASH_ENV`, or
  `AGENTCTL_SESSION_ID` changes an agentctl bridge test.
- The agentctl bridge stops chaining the prior `BASH_ENV`, publishing a later
  session id with its wake environment, or seeding a known resume id before
  provider startup.
- A Bash bridge probe accidentally inherits socket-backed stdin and silently
  exercises `.bashrc` startup instead of the intended `BASH_ENV` path.

## Related topics

- [ya-env-vars.md](ya-env-vars.md) — names, aliases, and consume-and-strip
  rules.
- [env-vars-config.md](env-vars-config.md) — proposed operator visibility and
  future child-process overrides.
- [cost-efficiency.md](cost-efficiency.md) — credential filtering and the
  metered-billing footgun.
- [claude.md](claude.md) and [session-liveness.md](session-liveness.md) — the
  local agentctl session-id bridge and its coordination-only semantics.
