# Where settings / UI options live

Topic: settings-ui-placement

Status: contract note. Two questions for any new user-facing option: **which
category** it appears under, and **which persistence mechanism** backs it. This
captures the precedents so new options land consistently instead of wherever
the nearest code happened to be.

See also:
[vanilla-defaults](vanilla-defaults.md) (novel user-visible behavior ships
configurable + default-off — governs whether an option is even default-on),
[fork-from-turn](fork-from-turn.md) (the worked example below: fork-after-summary
auto-open),
[storage-settings](storage-settings.md) (server-wide storage location and
tool-result preservation),
[settings-search](settings-search.md) (how options are found: the shared
`SettingsItem`/`SettingsSection` row layer every pane's rows should use so
they stay searchable),
[project-settings-overrides](project-settings-overrides.md) (the project tier
below the global one that § Server-definitive settings and constants defines),
[client-global-store](client-global-store.md) and
[server-capabilities](server-capabilities.md) (the retained-query coverage keys
and capability gating that § Server-definitive settings and constants reasons
about).

## Persistence mechanisms (pick one deliberately)

YA has three, and the choice is about *scope of persistence*, not convenience:

1. **Browser-local preference** — `localStorage` via a `UI_KEYS` or
   `BROWSER_LOCAL_KEYS` entry (`lib/storageKeys.ts`) and a small hook returning
   `[value, setValue]`. Models: `useAttachmentUploadQuality`,
   `useOutputAppearance`, and `useModelSettings`'s local model/thinking/speech
   overrides. Use for a local view/UX or client-side default that need not
   follow the user to another browser profile.

2. **Source-scoped client storage** — local browser storage keyed by
   `ClientSummarySourceKey` in the owning helper (`clientSummaryStore`,
   `sessionDraftStorage`, `useDrafts`, session UI storage). Use when a hosted
   or multi-server client needs independent client-side state per source, such
   as drafts and source-specific session UI handoff state.

3. **Server-persisted setting** — `useServerSettings` / `updateSetting`
   (`settings.*`). Model: `newSessionDefaults` (in `ModelSettings.tsx`). Use for
   config applied at session start that is genuinely server/session state
   (default model, permission mode, delivery windows) and must survive on the
   server.

Decision rule: pure local rendering/UX or a browser-profile default → (1).
Client state that must not collide across hosted/remote sources → (2).
Session/server config that seeds new sessions or must survive on the server →
(3).

### Explicit browser-settings backup

The Settings navigation exposes one server-stored Save/Load slot for portable
browser preferences. This is a transfer mechanism layered over (1), not a
fourth persistence scope: settings remain browser-local until the user presses
Save, and Load replaces the allowlisted preference set before reloading the
client. Server-persisted settings in (3) already survive and are not duplicated
into the backup.

The client owns an explicit allowlist. Browser identity, relay/auth and speech
credentials, source-scoped state, drafts, cache contents and runtime
measurements, hardware device ids, recent-project history, and legacy migration
keys never enter the server copy. Hosted clients show the controls only when
the connected server advertises `browser-settings-backup`; older servers retain
the ordinary local settings behavior.

## Server-definitive settings and constants

Status: **contract, not yet implemented (2026-08-05).** No option or constant
has been migrated. This section fixes the rule before values accumulate on the
wrong side of it.

**The principle: a client must not send its own constant to an API that suffers
from variation in it.** An API suffers when a different value bloats what the
server holds, or when work done for one value cannot be reused for another.
Values feeding such an API are **server-definitive** — a server-owned constant,
or a server-owned configurable option — never a number each client happens to
carry.

The two words in play are not synonyms: *server-definitive* says who decides
the value (the server, not the client), and *server-wide* says what its scope
is (one value for the whole install). A server-definitive value is necessarily
server-wide; the reverse framing is what the rest of this section uses when
talking about scope rather than ownership.

The three mechanisms above are chosen by *scope of persistence*. That rule is
incomplete: it asks where a value should survive, never what the value costs
the server to honour. So ask first: **does the receiving API suffer from
variation in this value?** If yes, the value is server-definitive — mechanism
(3), one value for the whole install — even when it reads like a view
preference and would otherwise land in (1), and even when it is a constant
today rather than a setting.

### Why "affects server work" forces a single value

Server work in YA is deduplicated by *identity*: the retained-query controller
shares an in-flight request when available coverage satisfies requested
coverage; `SourceVersionedSingleFlight` joins callers on a source version; the
session catalog answers from a shard digest. Every one of those is a cache
keyed by what was asked for. So a preference that reaches the server does not
cost one client's worth of work — it partitions the cache. Two browsers with
different values are two coverage keys, two derivations, two retained results,
and neither satisfies the other. Ten clients with a free choice are up to ten
copies of work that has one right answer.

The live demonstration is already in the tree, and it is instructive precisely
because no user chose it: `limit` is part of the global-sessions query key, so a
50-row Sidebar fetch and a 100-row All Sessions fetch do not satisfy each other
(`docs/tactical/031-client-query-controller.md` § Coverage Model). That fan-out
is code-owned and bounded — two constants. Exposing the same knob as a
browser-local preference would make it unbounded and per-client.

### A client constant is not the safe option either

Being a constant is not what makes a value safe; being *one* value is. A
constant compiled into the client partitions the cache exactly as a preference
does, only along client-build lines instead of user-choice lines. Two clients
of different vintages against one server — a freshly published hosted bundle
and a browser still serving a cached one, a `localhost` dev client beside the
hosted client, a native app pinned to an older release — hold different
constants and issue non-satisfying coverage keys, and the server derives both.
That is the same divergence synchronized publishes are meant to prevent, but
arising from cache lifetime rather than release timing, so release discipline
does not close it.

So for any value that reaches the server, prefer a **server-owned constant**
over a client one, whether or not it is user-configurable. The server states
the value and the client consumes it; every connected client then agrees by
construction rather than by everyone having shipped the same number. Making it
configurable afterwards is then a UI change over an existing contract, not a
re-plumbing. `limit` is the obvious first candidate — the value is the server's
own pagination decision, and the client has no independent basis for choosing
50 or 100.

Ordering, cheapest first: server-owned constant → server-owned constant exposed
as a server-wide setting → per-client value with the duplicated work recorded
deliberately. Reach past the first only for a reason stated at the time.

**Current state, stated so nobody over-migrates.** A search of `UI_KEYS` and
`BROWSER_LOCAL_KEYS` found no user-configurable setting that today multiplies
server caching: the client-owned options are appearance, layout, output
rendering, speech capture, client-side transcript caching, and similar, all of
which the server never sees. This section is therefore a rule for *new* options
and for any existing one that grows a server-visible effect — not a backlog of
migrations. Audit before migrating anything; do not assume a candidate list.

### The test

Ask, of the value:

1. Does it reach the server at all — as a request parameter, a query-key
   component, or a field the server stores or branches on? Purely local
   rendering (fonts, spacing, collapse state, tooltip style) never does.
2. Does the receiving API suffer from variation in it? It suffers if a
   different value means work that cannot be reused (a distinct coverage key,
   a distinct derivation, a distinct single-flight identity) or state the
   server must hold per value. A value echoed back unchanged, or one the server
   only records, does not make the API suffer.

Both yes → server-definitive. Either no → the existing scope rule governs,
unchanged.

Note that (2) is a property of the *endpoint*, not of the value's name. The
same number can be harmless on one route and cache-partitioning on another, so
answer it against the specific API the value is sent to.

### What choosing server-wide forecloses

A server-wide setting is not a preference. One client changing it changes it
for every connected client and every other user of that install, including
mid-session. That is the point — it is what makes the single cache entry
correct — but it means the option can no longer express personal taste, and a
setting genuinely wanted per-person cannot be resolved by making it
server-wide. When a value is both per-person and server-affecting, the honest
resolutions are to bound the domain to a few discrete server-owned values, so
the fan-out is small, known, and identical across clients; or to keep it
per-client and record the duplicated work as a deliberate cost. Neither is
"leave it a client constant and hope every client ships the same one".

This also interacts with the local rule that a new feature must not silently
re-default existing behavior (`CLAUDE.local.md` § UI Changes Preserve Non-Buggy
Defaults). Migrating an existing browser-local option to server-wide *is* such
a re-default for every client whose local value differed from the new shared
one. Such a migration needs the maintainer's explicit go, and should carry the
previous local value forward as the initial server value where a single
sensible one exists.

### Making the nature visible

A user cannot be expected to infer that one row in a pane is shared with
everyone while its neighbours are not. Group server-wide options under their
own settings category rather than marking them individually: a category carries
the explanation once, in its description, instead of repeating a badge per row
and leaving unbadged rows ambiguous. `storage` is the existing precedent — it
is already server-wide in fact (storage location, tool-result preservation; see
[storage-settings](storage-settings.md)) — so the category should be the site
where that fact is stated, and new server-wide options should join it or a
sibling rather than being scattered by feature area.

Rows must still use the shared `SettingsItem`/`SettingsSection` layer so they
stay findable by search ([settings-search](settings-search.md)); grouping is
about explaining scope, not about hiding options from search.

### Deployment assumption

The hosted client is published together with the server code it talks to, so a
server-owned value ordinarily reaches every client in one release and a
migration does not need a negotiated dual path. That lowers the cost of moving
a value server-side; it does not remove the capability gate. Skew still happens
by accident — an un-updated Android client, a half-landed Pages deploy, a
cached bundle, a forgotten publish — and a client that hard-fails when the
server-owned value is absent turns each of those into a broken app rather than
a degraded one. Give a new server-owned value a defined client-side behavior
when the server does not supply it, which for a value like `limit` means the
client's current constant serving as the fallback rather than a required field.

Details, failure modes, and why this is an intent rather than a guarantee:
[remote-hosted-compatibility](remote-hosted-compatibility.md) § Synchronized
distribution is the intent, not the guarantee. Changes shipped upstream to
`origin` follow CLAUDE.md's review unchanged.

### Relationship to project overrides

Server-definitive is the global tier of the resolution order sketched in
[project-settings-overrides](project-settings-overrides.md) (project override →
global setting → built-in default). A setting that is server-wide *because* it
partitions a cache is a poor candidate for a project override later, since a
per-project value re-partitions the same cache along a different axis. Note
that when adding one.

## Categories (what each is *for*)

The category registry is `CATEGORY_COMPONENTS` in
`packages/client/src/pages/settings/SettingsLayout.tsx`; labels/descriptions come
from `getSettingsCategories` in `packages/client/src/i18n-settings.ts`. Current
inventory: `appearance`, `toolbar`, `model`, `message-delivery`,
`agent-context`, `notifications`, `webhooks`, `devices`, `local-access`,
`remote`, `providers`, `speech`, `remote-executors`, `emulator`, `environment`,
`about`, `development`.

Placement precedents (the load-bearing ones — choose by *what the user is
conceptually adjusting*, not where the code lives):

- **Appearance** — visual presentation (fonts, spacing, visibility toggles like
  show-thinking's display, and the style/timing of transient presentation such
  as tooltips). Most Appearance effects are visible at rest; a presentation
  preference does not move to Toolbar merely because hover reveals it.
  `AppearanceSettings.tsx` / `useOutputAppearance`; see
  [tooltip-interactions](tooltip-interactions.md).
- **Toolbar** — which **commands / affordances** are shown in the toolbar.
  `ToolbarSettings.tsx`.
- **Model + new-session defaults / options** — things **set on session start**:
  default model, permission mode, thinking config, and UI elements that seed a
  new session. `ModelSettings.tsx` hosts `newSessionDefaults`; `showThinking`
  (browser-local, with a live toolbar toggle) lives in this cluster via
  `useModelSettings`.
- **Providers** — provider-specific availability, authentication, and catalog
  policy. Opting exact previous/custom Claude ids into the server's available
  model catalog belongs in `ProvidersSettings.tsx`, even though the resulting
  entries later appear in model choosers. It is server-persisted and
  capability-gated because a hosted client edits the connected server's
  provider catalog. The provider list presents Codex first, Claude second, then
  the remaining registered providers; see
  [older-claude-models](older-claude-models.md).

Introduce a **new category** only when a sizable cluster of options doesn't fit
an existing one; a single niche toggle joins the nearest existing category.

### Storage category — approved, pending implementation

**Storage** appears immediately after **Source Control** and owns two
independent server-wide choices: where YA-managed project data may live and
whether YA preserves new tool-result images from managed sessions. This earns
a category despite its small initial control count because it is a filesystem
trust and retention boundary, neither control fits an existing category
honestly, and older-server limitations must remain visible. It does not absorb
browser-local cache tuning from **Performance**.

The exact radio choices, defaults, persistence fields, capability gates, and
missing-capability states are in [Storage Settings](storage-settings.md).

## The default + live-override pattern

A persistent default may be paired with an **ephemeral, in-context toggle** that
seeds from it. `showThinking` is the canonical case: a browser-local default
(settings) plus a live toolbar switch for the current session. The override is
**not itself a setting** — it is transient session/job state. Reach for this
pattern when the user may want to flip the behavior for *this* session/action
without changing their standing default.

## Worked example: fork-after-summary auto-open

The fork-after-summary "open the forked session in a new tab when ready" option
(see [fork-from-turn](fork-from-turn.md)) is, in the project owner's words,
"analogous to show thinking, a little more niche." It belongs near the
model / new-session cluster (`ModelSettings.tsx`) if a persisted default is
added, but the install-id localStorage excision deliberately did **not** add
that persistence. Current behavior remains **default-off and non-persistent**;
adding a browser-local or source-scoped default would be a product behavior
change and should be documented when it lands.

- **Default:** no persisted default today; each new mount seeds the behavior to
  off per [vanilla-defaults](vanilla-defaults.md). A future dedicated "Sessions"
  category could absorb it if that cluster grows; not warranted for one toggle.
- **Live per-fork override:** an ephemeral toggle on the `ForkSummaryIndicator`
  during the *generating* phase, seeded from the default. It is per-fork
  transient state, not a setting.
- **What the toggle does — and does not — control:** the forked session is
  created and *starts* (the summary is submitted as its first user turn) as soon
  as generation completes, unless canceled. The toggle gates only the
  client-side `window.open` to a new tab; the fork/session runs regardless, and
  the indicator's link is how the user reaches the already-running session.
  Because the auto-open decision is read at the *ready* transition (after a long
  await), read the live toggle value from a ref — like the abort ref — so a flip
  during generation is honored.
