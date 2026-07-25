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
[settings-search](settings-search.md) (how options are found: the shared
`SettingsItem`/`SettingsSection` row layer every pane's rows should use so
they stay searchable).

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
  provider catalog; see
  [older-claude-models](older-claude-models.md).

Introduce a **new category** only when a sizable cluster of options doesn't fit
an existing one; a single niche toggle joins the nearest existing category.

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
