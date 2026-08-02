# Notification Delivery Validation And Native Readiness

Status: active. Browser implementation and the three defects found during live
verification are fixed; bounded failure cases and the native-destination
readiness review remain in progress.

Topic: notifications
Topic: android-fcm-push

## Origin

YA previously exposed a direct in-page **Desktop Notifications** control whose
permission and test actions were not connected to production session events.
Commit `fe31eeff` removed that misleading path, made Web Push the single
browser delivery mechanism, and organized Settings around **This browser**,
**Events from this server**, and **Devices and delivery**.

Automated contracts cover server audience selection and service-worker
presentation decisions, and the replacement has now been walked end to end in
a real desktop browser. Native Android enrollment will extend the same Settings
surface and server event policy from that proven browser baseline rather than
introduce a second parallel notification UI.

This document is the durable execution ledger for that baseline and the
handoff into native work. Record observed outcomes here; do not treat a passing
unit test or an accepted provider request as proof that the operating system
displayed a notification.

## Related Contracts And Plans

- [Notifications](../../topics/notifications.md) owns server event policy,
  transport, and recipient-presentation boundaries.
- [Web Push troubleshooting](../push-notifications.md) describes browser and
  deployment prerequisites.
- [Browser-profile devices](../../topics/browser-profile-devices.md) owns the
  identity currently shared by browser connections and Web Push.
- [Android FCM push](../../topics/android-fcm-push.md) owns broker/Firebase
  lifecycle evidence and retry policy.
- [Android wrapper and notification integration](071-android-wrapper-notification-integration.md)
  owns native secrets, bridge permissions, enrollment, and tap behavior.
- [Mobile companion app](../project/mobile-companion-app.md) owns the eventual
  Compose Conversation-view direction.
- [Server capabilities](../../topics/server-capabilities.md) and
  [remote-hosted compatibility](../../topics/remote-hosted-compatibility.md)
  govern the future native enrollment API.

## Live-System Safety Boundary

Validation and defect work use a standalone YA data/provider profile on
separate ports plus a disposable browser profile. The maintainer's live
`https.localhost` configuration and the already-running server on port 3400
are immaterial to this checklist and must not be modified for it.

- Do not restart, replace, reconfigure, or point automation at the live server;
  other sessions may be active.
- UI actions, browser enrollment, targeted test sends, and read-only server
  inspection are in scope.
- Do not use a real provider session merely to manufacture an approval or
  question without recording that choice first.
- If source changes, debug-only routes, alternate VAPID state, destructive
  failure injection, or server instrumentation become necessary, run a second
  YA server on a different port with a fresh temporary profile/data directory.
- Do not point automated browser contexts at the primary server when the
  existing real profile can perform the check. If automation is necessary, it
  must retain YA's stable `automation` browser-profile identity.
- Never print VAPID private keys, Web Push subscription keys, broker secrets,
  FIDs, or native installation capabilities into this ledger or command
  output.

## Evidence Standard

Use these result values in the execution record:

- **Pass:** the externally visible result was observed.
- **Fail:** the expected result was not observed or a contradictory result was
  observed.
- **Blocked:** an explicit prerequisite is absent; name it.
- **Not run:** deliberately deferred; name the reason and the safe next action.

For each live check, record the date, browser/OS, origin, starting permission
state, action, visible outcome, and any relevant server/browser error. Avoid
recording private session text, subscription material, or credentials.

## Execution Record

| Date | Target | Check | Result | Evidence or blocker |
| --- | --- | --- | --- | --- |
| 2026-08-02 | Chrome 150.0.7871.127/macOS 26.5.2, `https://127.0.0.1:3400/` | Primary-origin preconditions | Fail | The unified Settings UI loads, but Chrome marks the origin not secure and rejects `/sw.js` with an SSL certificate error because the self-signed certificate is untrusted. The primary server was not restarted or changed. |
| 2026-08-02 | Chrome 150.0.7871.127/macOS 26.5.2, `http://localhost:3480/` | Isolated preconditions | Pass | A disposable server/data profile used the browser-trusted localhost secure-context exception. Notification APIs, service-worker registration/control, VAPID public-key availability, Chrome OS permission, and the unified Settings UI were present. No key material was recorded. |
| 2026-08-02 | Same isolated target | Browser enrollment | Pass | An explicit click granted permission, created one subscription, unlocked event controls without reload, and survived navigation away and back without duplicating the row. |
| 2026-08-02 | Same isolated target | Focused test and OS retention | Pass | Settings reported `Sent test push to Mac.` The service worker received it, and the user observed a Yep Anywhere test notification in macOS Notification Center by opening the clock. |
| 2026-08-02 | Same isolated target | Background/no-tab transport | Pass | Targeted persistent/high-priority API sends returned success. After the only YA tab navigated away, the next send woke the service worker; its durable log count advanced from two receipts to three, and the subscription remained after returning. |
| 2026-08-02 | Same isolated target | Fresh banner presentation | Blocked | A fourth persistent test was accepted and received by the service worker. Computer Use does not capture macOS global notification overlays, and no independent user observation of this fresh banner has yet been recorded. |
| 2026-08-02 | Same isolated target | Semantic recipient matrix | Pass | Controlled `pending-input` payloads exercised the real worker path. An unfocused/no-tab client displayed; a genuinely focused page suppressed with the opt-in off; the focused opt-in displayed for another session; and the already-visible session stayed suppressed. |
| 2026-08-02 | Same isolated target | Semantic dismiss isolation | Pass | A `dismiss` intent closed the matching no-tab session notification. The unrelated focused-opt-in notification and the test notification remained active, and no probe created duplicate active notifications. |
| 2026-08-02 | Same isolated target | Notification click navigation | Pass | The user clicked the retained focused-opt-in notification. Chrome focused YA and navigated to the exact isolated project/session URL; the worker logged the click and resolved app URL. The expected synthetic `Session not found` page proved routing without creating a provider session. |
| 2026-08-02 | Same isolated target | Remove and re-enroll truthfulness | Fail | Remove deleted the only server row and disabled event controls, and an off/on cycle restored exactly one subscription row without another permission prompt. However, Remove initially left **Browser notifications** visibly enabled despite zero server subscriptions. |
| 2026-08-02 | Same isolated target | Device inventory labeling | Fail | The current macOS Chrome subscription is displayed as `Mac (Android/Chrome)` because endpoint-based naming incorrectly treats Chrome's Google push service as Android evidence. |
| 2026-08-02 | Same isolated target | Closed-tab activity teardown | Fail | Full navigations accumulated four server-tracked activity connections for the one YA tab. Closing that tab left all four registered after 3 seconds and after 40 seconds, spanning the 30-second WebSocket heartbeat. Three disconnected only many minutes later; one remained until isolated-server shutdown. |
| 2026-08-02 | Standalone Chrome/macOS profile, `http://localhost:3580/` | Removal and device-label fixes | Pass | A real FCM/Web Push enrollment displayed `Mac (Chrome)` with **Browser notifications** enabled. Removing the current row revoked the only server subscription and changed the independently mounted browser toggle to disabled without reload; browser console errors remained zero. |
| 2026-08-02 | Standalone automated browser profile, separate YA profile on port 3580 | Activity teardown fix | Pass | One loaded document registered one tab. Synthetic `pagehide` reached zero immediately, `pageshow` returned to one, three full reloads stayed at one, and navigation to `about:blank` reached zero within the 50 ms polling cadence. |
| 2026-08-02 | Same standalone Chrome profile | Final responsive rendering | Pass | The subscribed Notifications surface was captured and inspected at 1920×1080 and 375×812. Both layouts were usable, the browser controls were enabled, and the desktop inventory showed `Mac (Chrome)` rather than Android. |

### 1 — establish real-browser notification preconditions

- [x] Record the browser and macOS versions without reading browser profile,
  password, cookie, or credential stores.
- [x] Confirm the validation origin is a browser-trusted secure context. If it
  uses the intended HTTPS origin, confirm it is not behind a browser
  certificate interstitial.
- [x] Confirm `serviceWorker`, `PushManager`, and `Notification` are available
  in the page.
- [x] Confirm the service worker is registered and controlling the expected
  scope after the current development configuration permits registration.
- [x] Confirm the server exposes a VAPID public key without recording the key.
- [x] Record the site's browser notification permission as `default`,
  `granted`, or `denied`.
- [x] Confirm macOS permits Chrome notifications, or record the OS setting as a
  blocker without changing unrelated notification preferences.
- [x] Confirm Settings shows the unified browser surface and does not show the
  removed direct **Desktop Notifications** control.

Observed 2026-08-02: the primary self-signed HTTPS origin fails the trusted
context requirement specifically at service-worker script fetch. The isolated
localhost origin passes all remaining preconditions; permission moved from
`default` to `granted` only after the explicit enrollment click. macOS System
Settings lists Chrome notification presentation as enabled. No OS setting was
changed.

### 2 — enroll and inventory this browser

- [x] From an explicit click on **Browser notifications**, grant permission if
  prompted and create a Web Push subscription.
- [x] Confirm **This browser** reports subscribed after the request completes.
- [x] Confirm **Devices and delivery** contains one subscribed row for the
  current browser profile, not a duplicate row minted by the check.
- [x] Confirm the server event toggles become operable without a page reload.
- [x] Reload the page and confirm enrollment and the device row persist.
- [x] Inspect browser console and visible UI for errors; a successful toggle
  with a hidden server failure is a failure.

Observed 2026-08-02: the notification flow had no hidden client/server failure.
Chrome's Issues panel separately reports two form controls without `id` or
`name` attributes plus development CSP advisories; these are not delivery
errors. The initially recorded macOS-as-Android labeling defect was
subsequently fixed and revalidated in a fresh standalone profile.

### 3 — prove Web Push delivery and operating-system presentation

- [x] Send the row's explicit **Test** notification while YA is focused. Test
  pushes deliberately bypass focus suppression and must display.
- [x] Confirm the Settings status reports server acceptance separately from
  observing the macOS notification.
- [x] Background the YA tab and send another targeted test from a second
  control surface; confirm the OS notification displays.
- [x] With no YA tab open for this origin, send a targeted test through the
  existing server API or another already-authenticated client; confirm the
  service worker wakes and macOS displays it.
- [x] Click the notification and confirm it opens the expected YA origin rather
  than an arbitrary payload URL.
- [x] Remove the subscription from **Devices and delivery**, confirm the row is
  removed, and confirm the event controls reflect that no destination exists.
- [x] Re-enroll once and confirm the current browser has exactly one active
  subscription.

Observed 2026-08-02: the background and no-tab sends both passed server
acceptance, service-worker receipt, and active browser notification-object
inspection. The no-tab receipt is proven by the durable service-worker log
after returning to the origin. The user also observed a test notification in
macOS Notification Center. A separate banner-animation observation remains
blocked because Computer Use does not capture global overlays. The
user-confirmed click opened the exact synthetic isolated session URL. Remove
and re-enroll reached the intended final subscription state. The initially
stale current-browser toggle was subsequently fixed by using the browser-local
unsubscribe path and synchronizing hook consumers; a fresh standalone
enrollment/removal passed without reload.

### 4 — verify recipient-owned production-event presentation

Test notifications always display and therefore cannot prove production
focus/session suppression. Use a controlled semantic notification source. If
the current server has no safe source, create an isolated second-server probe
instead of modifying or restarting the primary server.

- [x] With YA unfocused, emit one controlled pending-input event and confirm a
  notification displays.
- [x] With YA focused and **Notify while YA is open** disabled, emit the event
  and confirm it is suppressed.
- [x] Enable **Notify while YA is open**, focus an unrelated session, and
  confirm the event displays.
- [x] Keep the notified session visible and confirm the same class of event is
  suppressed even with the focused-window option enabled.
- [x] Resolve the pending input and confirm its dismiss intent closes the
  matching notification without closing unrelated YA notifications.
- [x] Confirm one semantic event does not produce duplicate visible
  notifications.

Observed 2026-08-02: one-off senders loaded only the disposable server's
temporary subscription/VAPID state and emitted synthetic semantic intents;
they did not change YA source or use a provider session. Worker logs and active
notification inspection proved each decision. DevTools focus is intentionally
not equivalent to page focus: the first probe displayed while DevTools owned
focus, then the same matrix passed after DevTools was closed before each send.

### 5 — exercise bounded failure and recovery behavior

Run disruptive cases in a disposable browser profile or isolated YA server
unless the state change is easily reversible and explicitly chosen.

- [ ] Permission denial leaves YA usable and reports a truthful remediation
  state.
- [ ] An OS-disabled Chrome notification setting is distinguishable from
  server acceptance, or is documented as an unavoidable browser limitation.
- [ ] Missing/disabled service-worker configuration reports unsupported or
  disabled delivery without claiming enrollment.
- [ ] Missing VAPID configuration produces an actionable server error.
- [ ] A rejected or expired Web Push subscription is removed or visibly
  degraded according to the browser notification contract.
- [ ] Reconnection/reload does not create overlapping registration attempts,
  duplicate subscriptions, or repeating server work.
- [x] Full navigation and tab close release every activity connection
  registration within the bounded WebSocket teardown window.

Initially failed 2026-08-02: one subscription remained singular, but repeated
full-page navigations accumulated four activity connection registrations for
the same browser profile. Closing the only YA tab did not remove any
registration after 40 seconds, including across the server's 30-second ping
boundary. This is not
an ordinary notification provider delay; it violates
[`architecture-mandates.md`](../../topics/architecture-mandates.md) resource
quiescence and makes the Settings tab count untruthful. Three delayed
disconnects arrived many minutes later, while one registration was still
present when the isolated server stopped; that nuance narrows the defect but
does not make the tab-close teardown timely or the displayed count truthful.

Resolved and revalidated 2026-08-02: browser-tab registration is now
socket-scoped rather than activity-subscription-scoped, and the client closes
retained activity subscriptions on `pagehide`. In a fresh standalone profile,
`pagehide` and navigation reached zero immediately, `pageshow` restored one,
and three full reloads never exceeded one registration.

### 6 — freeze the native-unification seam

Record the client/server proposal before changing the contract:

- [x] **Events from this server** remains one server-owned policy shared by
  every notification transport.
- [x] Browser and native recipients use distinct durable identities; an
  Android installation is never represented as a `browserProfileId`.
- [x] The Settings view model can merge discriminated browser/native
  destinations with common display, status, test, and remove operations while
  retaining transport-specific details.
- [x] The first Settings section is context-aware: **This browser** uses Web
  Push; an Android wrapper with the approved bridge uses **This Android app**.
- [x] Server event controls are gated by any eligible destination, not by Web
  Push subscription count alone.
- [x] Existing browser routes and storage remain compatible; native enrollment
  uses a new capability and sends no unsupported request to older servers.
- [x] Event observers emit semantic intents; Web Push and native broker
  adapters own their different payload privacy and provider behavior.
- [x] Browser-only diagnostic options do not masquerade as native options;
  Android permission/channel state remains device-owned.

Recorded 2026-08-02 in the owning notification topics and wrapper plan. The
native foundation implements only device-owned status, permission, channel,
and broker-installation lifecycle. The discriminated Settings destination and
exact YA-server capability/routes remain the next compatibility-reviewed
implementation rather than being implied by this completed design seam.

### 7 — approve the native implementation handoff

Native foundation work may begin independently, but the hosted client/server
enrollment contract is ready to implement only when:

- [ ] the live browser delivery baseline has no unexplained failure;
- [ ] any unrun manual matrix case has an explicit safe harness or justified
  release deferral;
- [ ] the native destination/UI seam above is recorded in the owning topic;
- [ ] the stable-release compatibility corpus, capability, routes, fallback,
  and revocation order have been presented for maintainer approval; and
- [ ] the implementation order preserves ordinary Web Push behavior when the
  native bridge or server capability is absent.

## Exit Result

At completion, summarize separately:

1. what a real browser and macOS visibly proved;
2. what only automated tests proved;
3. what remains blocked or deliberately isolated;
4. whether the existing browser baseline needs a fix before native work; and
5. the exact approved first native implementation slice.

## 2026-08-02 Disposable-System Cleanup

- The isolated server reported zero Web Push subscriptions before shutdown.
- The server on port 3480 stopped cleanly; the primary server on port 3400 was
  not restarted or changed.
- The disposable server/profile directory and its generated VAPID key pair
  were deleted. They contained no provider sessions or production credentials.
- Chrome retains the localhost origin's granted notification permission and
  client-side Push subscription. Its matching disposable server subscription
  and VAPID key no longer exist, so it is inert. Clear the localhost origin's
  site data before reusing port 3480 for a future push test.
