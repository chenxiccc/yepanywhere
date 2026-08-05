# Project Settings Overrides

> Banked seed: per-project settings overrides — project-scoped values
> affecting views/activity for any session in that project, taking
> precedence over global settings — are easy to add mechanically but painful
> to visualize/navigate, and have no current use.

Topic: project-settings-overrides

See also: [settings-ui-placement](settings-ui-placement.md) § Server-definitive
settings and constants — the global tier this resolution order sits above, and
the rule that a value an API suffers variation in should be server-definitive
rather than a constant each client carries. A value that is server-definitive
because it partitions a server cache is a poor candidate for a project
override, since a per-project value re-partitions that cache along a different
axis.

Status: **banked seed (2026-07-24).** From the kzahel chat, in the context of
"only cool really if it's project specific": rather than a plugin
architecture ([[server-plugin-arch]]), the lighter project-specific lever
would be settings overrides scoped to a project. Recorded as an observation,
not a plan — "no real use for, just pointing out."

## Shape

- Resolution order: project override → global setting → built-in default.
- Scope: an override affects views/activity for *any session in that
  project*, whichever client views it.
- Mechanically easy (the settings read path gains one lookup level); the
  real cost is UI: where a user sees that a project diverges from global,
  what the effective value is, and how to find/clear the override — "pain
  to visualize/navigate."

## Precedent and reopen conditions

[[attachment-storage]] § "Future: per-project override" already records this
exact pattern for one setting (global-only v1, per-project later, with the
v1 shape kept override-compatible). That per-setting approach — add a
project scope only when a concrete setting needs it — is the likely path;
a general project-overrides pane is justified only once several settings
have grown project scopes and the visualization cost is paid once for all
of them. Candidate early adopters if need appears: attachment storage
location, [[interactives]] exposure/tunnel policy, [[session-defaults]]
values that are really project conventions.

## See also

- [[server-plugin-arch]] — the heavier project-specific mechanism banked in
  the same chat.
- [[settings-ui-placement]] — where an override surface would have to live
  if built.
