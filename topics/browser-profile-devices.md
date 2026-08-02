# Browser-profile Devices

> A browser profile is YA's persisted identity for one browser's `localStorage`,
> created on first activity subscription and shown in the Devices UI; automated
> test browsers must collapse to one stable identity, and stale non-push
> profiles are bounded.

Topic: browser-profile-devices

Status: implemented in YA (2026-07-01). The external browser-harness pin from
the original plan is not landed here because that harness lives outside this
repo; YA no longer depends on harness cooperation for bounded behavior.

See also:
[settings-ui-placement](settings-ui-placement.md) (Devices has its own settings
category, while Notifications has a related push-subscription device surface),
[vanilla-defaults](vanilla-defaults.md) (the fix must not change behavior for
real devices — default-preserving), and the browser-control guidance in
`CLAUDE.md` (headless Playwright was the contamination source).

## What the Devices UI shows

Two surfaces render "devices", both keyed by `browserProfileId`:

- **Settings → Devices** (`packages/client/src/pages/settings/DevicesSettings.tsx`)
  lists every persisted browser profile from `browser-profiles.json`. Display
  name falls back to a truncated UUID; each profile shows its connection
  origins (`http://localhost:3400`, user-agent-parsed "Chrome · Linux", last
  seen). "Forget" calls `deleteProfile` (DELETE route in
  `packages/server/src/routes/browser-profiles.ts`).
- **Notifications → Devices** (`packages/client/src/pages/settings/NotificationsSettings.tsx`,
  `mergeDevices`) merges push subscriptions with live connections. Only the
  push-subscribed rows persist and get a Remove button.

Push endpoint domains identify the browser delivery provider, not the device
operating system. The Notifications inventory combines the endpoint with the
server-inferred `deviceType`: Google's endpoint is **Chrome** on desktop and
**Android/Chrome** only with Android evidence; Apple's endpoint is **Safari**
on desktop and **iOS/Safari** only with iOS evidence.

The persistent pollution is **`browser-profiles.json` only**. The in-memory
`ConnectedBrowsersService` self-cleans on disconnect, and `push-subscriptions.json`
would only grow if automation subscribed to push (it doesn't).

## Lifecycle contract (as built)

1. Each browser stores a random UUID under `localStorage['yep-anywhere-device-id']`
   (`getOrCreateBrowserProfileId` in
   `packages/client/src/lib/storageKeys.ts`). The same id also keys push
   subscriptions and remote client-log files.
   - Automated browsers (`navigator.webdriver === true`) do not read or write
     that browser-local key. They use the fixed `automation` browser profile id
     so every Playwright context groups into one profile.
2. On activity subscribe, `RelayProtocol.subscribeActivity` carries
   `browserProfileId` plus `originMetadata` (`origin`, `scheme`, `hostname`,
   `port`, `userAgent`). Remote SRP login also includes the same metadata via
   `SecureConnection.startFullSrpHandshake` for remote-session tracking, but
   browser-profile persistence happens on the activity subscription.
3. `handleActivitySubscribe` in
   `packages/server/src/routes/ws-relay-handlers.ts`
   calls `browserProfileService.recordConnection(...)` whenever both
   `browserProfileId` and `originMetadata` are present. First sight creates the
   profile; later subscriptions update `lastActiveAt` and the matching origin.
4. `BrowserProfileService.recordConnection` in
   `packages/server/src/services/BrowserProfileService.ts`
   creates a `StoredBrowserProfile` on first sight and persists it to
   `browser-profiles.json`, then prunes non-protected profiles:
   - Push-subscribed profile ids are protected via `PushService.getSubscriptions`.
   - Non-subscribed profiles older than 30 days are pruned.
   - At most 20 non-subscribed profiles are retained; oldest excess profiles are
     pruned.
   - Manual "Forget" still calls `deleteProfile` for explicit removal.
5. One physical WebSocket contributes at most one live tab registration.
   Overlapping activity streams on that socket share the registration, and
   the final activity-stream cleanup releases it. On `pagehide`, the client
   closes retained activity streams before the document is discarded or
   cached; a retained document that receives `pageshow` installs one fresh
   stream. Full reloads and tab close therefore do not accumulate logical tab
   rows while waiting for transport-level dead-peer detection.
6. Removing the current browser from Notifications uses the local
   `PushManager.unsubscribe()` path and then revokes the server row. Other
   device rows use server-only deletion because one browser cannot revoke
   another browser's local PushManager state. All mounted push controls
   reconcile from the browser-local subscription-change event, so the row and
   **Browser notifications** toggle converge without a reload.

**The invariant:** a browser profile should represent a durable device identity
worth showing the user. Automation gets one stable identity, and unknown clients
that keep presenting fresh UUIDs cannot make the persisted list grow without
bound.

## Root cause of the contamination

Playwright launches a **fresh browser context per run -> empty `localStorage` ->
a brand-new UUID every session** unless YA detects automation first. So the
persistent browser harnesses, and any headless Chromium pointed at the live dev
server, previously deposited one permanent "Chrome ... Linux · localhost"
profile per testing session.

This is **not** fork / synthetic-session / helper related: forks and synthetic
sessions are server-side session concepts and never call `recordConnection`,
which fires only from a real browser's WS activity subscription.

**Why the e2e suite is not the source:** the Playwright e2e tests run against an
isolated temp data dir (`packages/client/e2e/global-setup.ts` uses `mkdtemp` ->
`E2E_DATA_DIR`), so they never touch `~/.yep-anywhere`. Contamination comes only
from headless browsers hitting the real server on `:3400` / `:4000`.

### Evidence (2026-07-01, this host)

- `~/.yep-anywhere/browser-profiles.json`: 10 profiles, 8 of them Chrome+Linux
  on `http://localhost:3400` (dozens more already hand-deleted).
- `~/.yep-anywhere-dev/browser-profiles.json`: 3 profiles, all Chrome+Linux on
  `http://127.0.0.1:4000`.
- Before this mitigation, no automation detection existed in the client
  (`navigator.webdriver` was unused).

## Implemented mitigation

1. **Client: collapse automation at the source.** When
   `navigator.webdriver === true`, `getOrCreateBrowserProfileId` returns the
   fixed `automation` id without reading or writing
   `yep-anywhere-device-id`. Headless testing then contributes one profile, and
   real devices are untouched.
   - Back-compat: the `yep-anywhere-device-id` key stays unchanged for real
     browser profiles.
   - Default-preserving: real browsers behave exactly as before.
   - `navigator.webdriver` is a grouping signal, not a security boundary.
     Stable automation identity was chosen over dropping metadata so the
     Devices UI can still show that automation is connected, without minting a
     new row per Playwright context.

2. **Server: bound the list.** `BrowserProfileService` prunes profiles with no
   push subscription whose `lastActiveAt` is older than 30 days, and caps
   non-subscribed profiles at 20 by evicting the oldest excess profiles. Pruning
   runs during service initialization and after each `recordConnection`.

3. **Harness: optional external pin.** A Playwright `addInitScript` that writes
   `yep-anywhere-device-id = "automation"` would still be a useful
   belt-and-suspenders guard for old YA servers, but it is no longer required
   for current YA. It is not implemented here because external browser
   harnesses live outside this repo.

4. **Immediate cleanup.** Use "Forget" in Settings → Devices, or delete the
   offending entries from `~/.yep-anywhere/browser-profiles.json` and the `-dev`
   copy.

### Rejected

- **Blanket-suppress `localhost` / same-origin connections.** Rejected:
  localhost is the primary real dev origin and the user legitimately wants to see
  real local devices; this would hide wanted rows to kill unwanted ones. The
  discriminator is *automation*, not *origin*.

## Decision

Do #1 and #2 in YA; leave #3 as optional external harness hardening. They address
different failure surfaces: #1 stops Playwright-style automation at the source,
and #2 bounds+self-heals every other client that presents fresh UUIDs. **#2 is
kept deliberately even though #1 prevents most new contamination**: it is the
only option that cleans old junk over time and survives incognito windows,
cleared storage, new harnesses, or third-party clients.

## Security-Client Migration Follow-Ups

The unified security-client audit initially projects these browser profiles,
connections, resume sessions, and Web Push subscriptions without changing
their ownership. Capable SRP web clients additionally register an
origin-scoped non-extractable WebCrypto key. IndexedDB/WebCrypto isolation means
one physical browser reaching the same server through different origins may
correctly appear as several key-verified web clients.

Later compatibility-reviewed work may:

- move Web Push ownership from the body-supplied `browserProfileId` to the
  authenticated security-client relationship;
- remove optional profile/origin metadata from plaintext `srp_hello` after the
  encrypted check-in is sufficient; and
- prune stale, session-less, push-less web security clients using the same
  30-day/oldest-first shape as this service while preserving a compact event in
  the server-global security ledger.

None of those migrations may invent continuity proof for a legacy profile,
change old-client behavior without its exact capability gate, or auto-prune a
key-verified native or push-holding client.
