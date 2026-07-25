# Composer recall drawer (Ctrl+Up prefix history) + `!!` always-on

> A scannable drawer folds up from the composer on Ctrl+Up, listing prior
> user turns (and, in a `!!` draft, prior bang commands) whose text
> **prefix-matches** the current draft; up/down/Enter recalls the selected
> turn's text into the composer, Esc/click-away restores the draft, any
> other keystroke keeps typing and dismisses, and a secondary control
> jumps to that turn. Bundled with an enablement change: `!!` execution and
> the recall drawer are always on; the only opt-in is the "!! Commands"
> sidebar section.

Topic: composer-recall-drawer

Status: **proposed, not implemented** (2026-07-25). Design owner: graehl.
Supersedes the bang-gated Ctrl+Up cycling and the "natural later extension"
note in [bang-commands](bang-commands.md). Complements, does not replace,
the existing Ctrl+R message-list isearch.

## Motivation

Plain ArrowUp already recalls your *last* submission into the composer
(`MessageInput.tsx` `recallLastSubmission`, always on). The useful
generalization — browse *all* prior turns, filtered by what you've typed
so far, and drop one back into the composer to edit/resend — was never
built (bang-commands.md parks it as "a natural later extension"). Ctrl+R
isearch searches the transcript by substring and *navigates* to a match;
it does not recall text and it is not a scan-friendly list. This fills
that gap with a completion-style drawer, reusing the isearch data and
plumbing rather than duplicating it.

## Enablement (changed from the earlier default-off stance)

Three separable concerns, each enabled independently:

- **`!!` execution — always on.** Typing `!!cmd` runs a local shell
  command (existing `BangCommandService` path). Rationale: shell-escape
  from the composer matches common harness conventions (Claude Code's `!`
  bash mode, REPL `!`), and the affordance is invisible until the user
  deliberately types `!!`. **Resolved:** authorized by graehl 2026-07-25
  via an explicit amendment to Vanilla Defaults (established-convention
  carve-out; see [vanilla-defaults](vanilla-defaults.md) § Known
  Exceptions), surfaced there for kzahel's review.
- **Recall drawer (Ctrl+Up) — always on.** It generalizes the existing
  always-on plain-ArrowUp recall, is keystroke-invoked (no default UI
  surface), and touches no provider routing, so it does not trip the
  Vanilla Defaults "novel visible concept" bar.
- **"!! Commands" sidebar section — the one opt-in.** The top-level
  sidebar entry (the discoverable history view) is what a first-timer
  might not understand, so its display stays behind a setting. This is the
  only thing `clientDefaults.bangCommandsEnabled` (or a renamed successor)
  should gate. Default for the sidebar entry: TBD (off keeps the current
  first-run surface unchanged).

### Vanilla Defaults: resolved by amendment

Always-on `!!` execution initially conflicted with `AGENTS.md` § Vanilla
Defaults ("anything that modifies the user's submitted text before it
reaches the provider ships default-off"). Resolved 2026-07-25 by a
graehl-authorized amendment adding an **established-convention carve-out**
to [vanilla-defaults](vanilla-defaults.md): a familiar cross-harness
affordance (shell-escape `!!`, cf. Claude Code `!` bash mode) that is
invisible until deliberately invoked and touches no provider-bound text is
not YA-novel and may ship always-on — while any *discoverable* surface it
adds (the "!! Commands" sidebar entry) still ships default-off. The
reversal is surfaced in that topic and the commit for kzahel's review.

## Recall drawer behavior

- **Trigger.** Ctrl+Up in the composer, always (no bang gating). Optional
  later: a click affordance near the collapse (down-arrow) toggle, mainly
  for touch keyboards with no Ctrl+Up.
- **Source, context-sensitive.** Normal draft → prior *user turns*. `!!`
  draft → prior *bang commands*. Same prefix-match mechanism over both, so
  the old bang Ctrl+Up cycling becomes the `!!`-context case of one menu.
- **Prefix match against the live draft.** The drawer lists history
  entries whose text begins with the current draft (case-insensitive,
  normalized). Empty draft → full history, newest-first, deduplicated.
  This is the net-new matching mode (everything today is substring).
- **Drawer UI.** A list drawer folding up from the composer (into the
  `.session-input-inner` above-composer region the isearch panel already
  portals into), one scannable row per entry: a one-line preview plus a
  secondary "go to this turn" control. Distinct from the isearch *input*
  panel and from the right-edge `UserTurnNavigator` rail.
- **Navigation.** Up/down move the selection (reuse the isearch
  arrow-repeat selection engine); Enter recalls the selected entry's full
  text into the composer (reuse the `setDraft`/correction plumbing, but
  over the multi-turn set, not today's single-last ref).
- **Dismissal.** Esc or click-away cancels and **restores the pre-drawer
  draft** (new original-draft ref, mirroring isearch's original-scroll
  restore). Any non-navigation keystroke dismisses the drawer and passes
  through to the composer ("keep typing"). With no prefix matches (or
  after Esc), Enter sends normally.
- **Go to this turn.** The secondary per-row control scrolls the
  transcript to that turn (reuse `scrollToRenderId` /
  `scrollSearchTargetIntoView`; anchors already carry the render-id
  `targetId`) without altering the composer.

## Reuse map (from a 2026-07-25 code survey)

Already present and reusable:

- **Prior-user-turn list with text + preview + jump target:**
  `getUserTurnNavAnchors` / `getUserTurnSearchAnchors`
  (`lib/sessionDetail/search.ts`), shape `UserTurnNavAnchor {id, preview,
  searchText, targetId, timestampMs}`.
- **Above-composer portal slot + panel pattern:** `useMessageListIsearch`
  portals into `.session-input-inner`.
- **Up/down + arrow-repeat selection engine:** `moveSearchSelection` /
  `handleSearchArrowKey` / `stopSearchArrowRepeat`.
- **Recall-into-composer plumbing:** `handleRecallLastSubmission` →
  `draftControls.setDraft` / `setCorrectionDraft` (single-last today).
- **Jump-to-turn:** `scrollToRenderId`, `scrollSearchTargetIntoView`,
  `UserTurnNavigator.handleJump`, `findRenderRow`.
- **Default-off client-setting pattern:** `bangCommandAvailability.ts` +
  `MessageDeliverySettings.tsx` (`settings.clientDefaults`).

Net-new:

1. Prefix matching against the live draft (all matching today is
   substring `.includes`).
2. The list-drawer UI (isearch's is a search *input*; the rail is a
   minimap, not a scan list).
3. Enter = recall text, over a *multi-turn* history (vs single-last ref).
4. Restore-original-draft on cancel.
5. Dismiss-on-any-keystroke.

## Keyboard reconciliation

- Ctrl+Up is bound today only inside the bang-gated branch
  (`MessageInput.tsx:1412`); free when bang is off. Folding bang history
  into the drawer's `!!`-context source removes the disambiguation
  problem — one Ctrl+Up behavior in all contexts.
- Ctrl+R / Ctrl+S / Ctrl+Alt+S stay the message-list isearch (substring,
  navigate). The drawer is prefix + recall; the two are complementary.
- Plain ArrowUp last-submission recall can remain as the zero-keystroke
  shortcut, or be subsumed by the drawer; TBD.

## Phasing

1. **(optional, cheap) isearch-preview select.** Let the existing Ctrl+R
   match preview select text other than the most recent match — a
   stepping stone graehl called acceptable, though the drawer is the
   real target.
2. **Recall drawer, desktop Ctrl+Up.** Prefix match + drawer list +
   Enter-recall + restore-draft + dismiss-on-typing.
3. **Go-to-turn column** and **mobile open affordance.** Fast follow.

## Open decisions

- Recall source = user turns only (recommended) vs. including other turn
  kinds; assistant turns reachable only via the go-to-turn control.
- Default state of the "!! Commands" sidebar entry once execution is
  always-on.
- Keep or subsume plain-ArrowUp single-last recall.
- Drawer vs. interim isearch-preview reuse for the first shipped revision.
