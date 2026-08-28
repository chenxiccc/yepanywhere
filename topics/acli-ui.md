# ACLI capability in the YA UI

> How YA decides a command is an ACLI tool — a testable `acli:`
> capability line in `--help`, mirrored as a script-head comment — and
> upgrades its composer UI (completion menus with per-candidate help,
> slot hints, a help panel) while ordinary shell commands keep plain
> shell behavior.

Topic: acli-ui

Status: proposal (2026-07-26). Nothing below is built except what
§ Current state records. The `--acli-complete` JSONL protocol and the
capability-line grammar are owned by `~/agents` `topics/acli.md`;
this doc owns YA-side detection, the trust registry, and UI
representation.

See also: [bang-commands](bang-commands.md) (the composer, execution,
and Tab-completion contracts this extends),
[vanilla-defaults](vanilla-defaults.md) (what may ship always-on vs
default-off).

## Current state

- The completion server invokes `tool --acli-complete <argv-prefix...>`
  for the last pipeline segment's command, gated on an explicit
  allowlist (`YA_BANG_ACLI_COMPLETERS` env plus the built-in
  `harness-check`); Tab never executes an arbitrary program.
- The protocol already returns rich candidates —
  `{"completion", "kind", "help"}` JSONL — but
  `listAcliArgCompletions` keeps only `completion`, and the menu row
  renders a single bare `<span>{value}</span>` (`MessageInput.tsx`).
  The per-candidate documentation acli tools emit (verb one-liners,
  flag help, data-derived values) is discarded one hop before the
  user.
- No help affordance: `!!tool --help` runs like any command; nothing
  in the UI knows a tool has structured help, per-dataset `help`
  verbs, or completion at all. The allowlist is hand-edited env
  config.

## Detection: a testable "is this an ACLI tool" hint

To be added to the protocol spec (`topics/acli.md`); recorded
here because YA is the consumer that needs it testable:

- **Capability line.** A compliant tool's `--help` output contains
  exactly one line matching `^acli: <version>( <capability>)*$`,
  e.g. `acli: 1 complete repl toon`. `<version>` is the protocol
  integer; capabilities are lowercase tokens (`complete` =
  `--acli-complete`, `repl` = interactive `--repl` mode, `toon` =
  TOON table verbs). The shared `acli.args` parser factory emits the
  line automatically, so compliant tools carry it for free.
  Testable: `tool --help | grep -E '^acli: '`.
- **Script-head mirror.** Script tools carry the same string as a
  comment in the first 1 KiB (`# acli: 1 complete`), readable
  without executing the file. Generated almanac launchers
  (`~/bin/<dataset>`) embed it at generation time.
- **Why `--help`, not a dedicated flag:** one invocation serves
  humans, agents, and detection; agents already read `--help`; a
  probe flag would be one more thing a lax non-compliant tool might
  misparse into running its default action.

## Trust and registration

Tab must keep never executing unregistered tools
(bang-commands.md § Tab completion). Detection therefore has two
paths, neither of which is a Tab-time probe:

- **Zero-execution identification.** When the command token resolves
  to a file, the server may read its head for the marker comment. A
  marker is a standing claim by the script's author; whether it
  auto-trusts the tool for `--acli-complete` is a default-off
  setting (auto-trust widens "Tab runs code" to any marker-bearing
  file on PATH, which the user must opt into).
- **Explicit registration.** A user gesture ("enable rich completion
  for this tool") runs `tool --help` once — timeout, output cap, no
  TTY — and greps the capability line. On match, the tool's
  basename, capabilities, and version land in a persisted registry
  (`{dataDir}/acli-tools.json`), consulted alongside
  `YA_BANG_ACLI_COMPLETERS` (env stays, as the no-UI escape hatch).

Ordinary shell commands hit neither path: no marker, no
registration — exactly today's behavior, no probes, no confusion.

## UI representation

- **Menu descriptions.** Completion rows render `help` as secondary
  dimmed text beside the candidate (fish / PowerShell precedent; the
  menu already distinguishes history vs token rows, so a description
  slot is an extension, not a redesign). `kind` may style rows
  (flag / subcommand / value / path).
- **Protocol fidelity.** The server passes candidates through whole;
  the endpoint response gains a structured field alongside the
  existing `completions: string[]` (shape versioning decided at
  implementation). The client honors candidate order as served, the
  proposed `nospace` field (accepting `tier=` must not append a
  space), and proposed non-insertable `kind:"hint"` rows (dimmed
  slot guidance when candidates are unbounded, e.g. free search
  text).
- **Composer chip.** While the draft's command is a registered acli
  tool, the existing always-on routing chip ("local command — not
  sent to agent") gains a small "acli" variant — an accuracy
  improvement to a surface bang drafts already show, not a new
  surface.
- **Help panel.** An explicit affordance on that chip (or long-press)
  runs `tool --help` — or a registered help verb like
  `almanac help <dataset>` — into a sheet, with bang-run output
  caps. The example-driven help acli tools already emit is exactly
  what a phone-bound user needs. As a new discoverable control it
  ships gated (candidate: the existing `bangCommandsEnabled`
  power-user toggle) per vanilla-defaults.
- **`repl` capability.** YA ignores it: the composer *is* YA's repl.
  The token exists for terminal consumers; at most it could gate a
  future dedicated explorer surface. Non-goal here.

## Open questions

- Auto-trust default for marker-bearing scripts — proposed off; is
  the marker's explicit authorship claim enough to flip it on for
  project-root (not PATH) files?
- Response-shape versioning for `/bang-completions` (parallel field
  vs versioned response).
- Whether the chip itself is the help-panel button or help gets its
  own icon.
- Hint rows: protocol-emitted only, or may the client synthesize
  them (the menu already hosts non-token history rows, so mixed row
  kinds are established)?
