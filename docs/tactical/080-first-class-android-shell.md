# First-Class Android Shell

Status: executing. The product decision is to replace the Tauri Mobile wrapper
before implementing Android broker enrollment or native notification
presentation. The existing Android package identity, Firebase probe, asset
channels, and full-web fallback remain inputs to the migration rather than
reasons to retain Tauri. Validation is physical-device-first whenever an
authorized Android device is attached; the existing JSTorrent-named AVDs are
shared development resources and may be used for YA when no device is
available or repeatable emulator coverage is more useful.

Topic: android-native-shell
Topic: android-fcm-push

## Origin

The current Android APK is a Tauri Mobile application with a generated Gradle
project, a small Rust host, a foreground WebView, and custom Kotlin Firebase
code inside the generated Android tree. That shape proved the bundled and
hosted client channels plus direct FCM receipt, but Tauri no longer owns enough
product behavior to justify its mobile build and runtime layer.

Android is now the first native companion target. Compose will own onboarding,
server profiles, inbox, and Conversation-view surfaces incrementally. The full
YA web client remains an explicit fallback for settings, rich activity, and
unsupported native detail. Android notification receipt, secure storage,
channels, taps, and future foreground activity are native responsibilities
regardless of which library owns the WebView.

The migration therefore moves Android to a first-class Gradle/Kotlin project
before those responsibilities grow around Tauri-specific APIs. It does not
change the separate desktop Tauri application.

## Related Contracts And Plans

- [Mobile companion app](../project/mobile-companion-app.md) owns the product
  journey, Compose direction, and full-web fallback.
- [Android wrapper and notification integration](071-android-wrapper-notification-integration.md)
  resumes native enrollment after this shell migration.
- [Android FCM push](../../topics/android-fcm-push.md) owns broker capabilities,
  registration lifecycle, and notification privacy.
- [Trusted client packaging](../../topics/trusted-client-packaging.md) owns the
  difference between bundled trusted assets and mutable hosted content.
- [Android credential sharing](../../topics/android-credential-sharing.md)
  owns the package, certificate, App Link, and password-manager association.
- [Hard development rules](../../topics/hard-development-rules.md) require
  explicit client origins and endpoint configuration to remain authoritative.

The Android platform basis is
[`WebViewCompat.addWebMessageListener`](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge),
which provides an origin-scoped message object and is recommended over the
legacy all-frame `addJavascriptInterface` API. Bundled assets use
[`WebViewAssetLoader`](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader)
so they retain a normal HTTPS origin rather than a `file:` or opaque origin.

## Validation Baseline

At plan creation on 2026-08-02:

- an authorized physical Pixel 7a running Android 17 / API 37 is attached over
  ADB;
- the local SDK has `jstorrent-dev`, `jstorrent-playstore`, and
  `jstorrent-tablet` AVDs, all of which are approved for general Android
  development rather than reserved for JSTorrent;
- the mobile Tauri project has no Android JVM or instrumentation tests;
- root typechecking excludes the mobile workspace;
- repository CI has no build or test job for the foreground Android app; and
- `bridge-ci.yml` builds the separate Android Device Bridge and is not evidence
  for this app.

Do not encode the currently attached device serial or model as a lasting test
requirement. Before each connected-device run, enumerate authorized devices,
select the intended target explicitly with `adb -s`, and record the model, API,
and active Android user with the evidence. Never use an unqualified install or
test command when more than one target is connected.

## Validation Strategy

Prefer the attached physical device for implementation feedback and acceptance.
It is the authoritative target for Firebase registration and delivery,
notification permission and tray behavior in the subsequent push plan, App
Links, password-manager association, and real WebView/provider behavior. An
existing local AVD is the fallback when no physical device is attached and is
also useful for repeatable lifecycle, screen-size, and failure-path checks.
There is no requirement to create a YA-named local AVD.

Validation is layered so a device test is confirmation rather than the only
place a contract can fail:

| Layer | Required coverage | Where it runs |
| --- | --- | --- |
| Kotlin JVM tests | Message parsing/dispatch, protocol and size failures, build-channel configuration, origin and navigation decisions, deep-link parsing | Local and CI |
| Client tests | Absent-host fallback, `host.describe`, feature gating, malformed replies, timeouts, and document cancellation | Local and CI |
| Android instrumentation | App-assets loading, approved-origin/main-frame authority, denied origins/subframes, external navigation, back, rotation, and activity recreation | Attached device first; local AVD fallback; CI emulator |
| APK inspection | Correct bundled/hosted asset contents, package identity, manifest contract, and absence of Tauri/Rust artifacts | Local and CI |
| Connected smoke | Launcher, relay login, process recreation, App Link, password-manager metadata, and FCM receive with no activity/WebView | Physical device when attached |

The shell migration does not require Firebase credentials in CI. Its
config-free build is a required, first-class artifact. FCM end-to-end delivery
remains a physical-device acceptance test using locally provisioned
configuration; credentials and `google-services.json` stay ignored and out of
logs, artifacts, screenshots, and repository secrets unless a separate CI
credential design is explicitly approved.

## Work Tracker

Update this table as slices land. A slice is complete only when its detailed
step and applicable validation rows below have evidence.

| Step | State | Completion evidence |
| --- | --- | --- |
| Freeze the existing shell evidence | complete | 2026-08-02 build, APK/manifest inventory, and Pixel 7a baseline below |
| Create the Gradle/Compose shell | complete | Warning-free config-free builds plus Compose launcher smoke on Pixel 7a |
| Reproduce client asset channels | in progress | Bundled Pixel smoke and both release APK contracts pass; hosted connected smoke remains |
| Add the native host channel | in progress | Protocol/client tests pass; real WebMessage `host.describe` passes on Pixel 7a; denied-origin/subframe instrumentation remains |
| Migrate App Links and FCM probe | complete | Exact verified App Link plus direct, broker-foreground, and no-process broker-background Pixel evidence |
| Remove Tauri Mobile | planned | Dependency/source deletion plus artifact inspection |
| Add Android CI | planned | Warning-free required workflow and uploaded APK artifacts |
| Prove physical-device equivalence | planned | Recorded connected acceptance matrix |
| Hand off to notifications/onboarding | planned | Updated downstream plan and no open shell blockers |

### Frozen Tauri baseline — 2026-08-02

The final pre-migration checkout built with:

```text
pnpm --filter @yep-anywhere/mobile build:android:debug
```

It produced
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
and the matching AAB. The universal debug APK was 438 MiB because it carried
Tauri/Rust shared libraries for arm64-v8a, armeabi-v7a, x86, and x86_64. The
build completed but emitted the existing Vite large-chunk advisory, npm's
recursive-environment warning from the Tauri Gradle subprocess, and Gradle 9
deprecation warnings from the generated/Tauri build. The replacement must not
inherit those Android build warnings.

Frozen package contract:

- application id and namespace: `com.yepanywhere.mobile`;
- version code/name: `1000` / `0.1.0`;
- compile/target/min SDK: 36 / 36 / 24;
- permissions: Internet and notification permission in the source manifest,
  with Firebase contributing network state, wake lock, and C2DM receive;
- launcher: exported single-task `.MainActivity` with edge-to-edge enabled;
- verified-link filter: `yepanywhere.com/open` (the generated manifest also
  admitted HTTP, which is not part of the HTTPS product contract);
- Digital Asset Links metadata through `@string/asset_statements`;
- conditional Google Services plugin with Firebase Messaging BoM `34.16.0`;
- debug cleartext enabled and release cleartext disabled; and
- default debug signing identity matching the published development
  association fingerprint.

The APK was installed by explicit serial on the attached Pixel 7a, Android 17
/ API 37, user 0. A cold launch and force-stop/relaunch both reached the bundled
remote connection chooser. Android reported the domain verified, but that
device user's link-selection state had `yepanywhere.com` disabled, so a shell
VIEW intent opened Chrome; later replacement testing must explicitly distinguish
domain verification from user link-selection state. Prior recorded broker/FCM
receipt remains the notification baseline and no FID or credential was
captured during this freeze.

### First-class App Link and Firebase evidence — 2026-08-02

The replacement preserved `com.yepanywhere.mobile`, the maintainer debug
certificate, Digital Asset Links metadata, conditional Google Services build,
Firebase BoM `34.16.0`, FID targeting, and the non-exported diagnostic service.
Both configured and config-free Gradle builds, unit tests, and Android lint ran
without warnings.

On the attached Pixel 7a running Android 17 / API 37, Android reported
`yepanywhere.com` verified. After enabling the device user's previously disabled
selection, a cold exact HTTPS `/open` intent resolved to the replacement
`MainActivity` and its Android-owned WebView. The replacement admits neither
HTTP nor `/open` path-prefix lookalikes, and its native parser maps accepted
credentials only to the fixed configured client origin's fragment.

A direct Firebase Console test to the current installation produced exactly one
foreground callback. Through `https://push.yepanywhere.com`, temporary
installation and subscription capabilities produced a `202` accepted send and
exactly one foreground callback with the expected data-key names. A second
`202` send began with no YA Activity, WebView, or app process alive and created
Android's generic YA notification without a service callback, which is the
expected background-notification path. Notification permission was granted by
ADB for this acceptance check; product permission UI remains out of scope. The
temporary broker installation was deleted and no FID or capability was printed
or retained.

## Scope

This plan owns:

- a conventional Android Gradle/Kotlin application with Compose available from
  the launcher activity;
- bundled and fixed hosted WebView client channels;
- an origin-bound, versioned web/native message channel;
- migration of the existing App Link and Firebase receive probe;
- preservation of the Android application id and installed-app identity;
- removal of mobile Rust, Tauri dependencies, generated-project ownership,
  and iOS-shaped commands from the Android package; and
- physical-device equivalence checks before deleting the old shell.

This plan does not implement:

- broker installation or YA-server native push enrollment;
- notification permission UI, channels, tray presentation, or tap routing;
- new server routes, fields, events, or capability advertisements;
- passwordless SRP pairing, QR-code login, or desktop installation guidance;
- native inbox, Conversation-view, approval, or composer behavior;
- an Android foreground service; or
- the future SwiftUI iOS application.

Compose onboarding is an intended next consumer of the shell. Passwordless QR
pairing is a separate security and client/server compatibility project; this
migration must not pre-commit its wire protocol or grant a generic native
camera/authentication bridge in anticipation of it.

## Target Package Shape

At cutover, rename the mobile workspace to the platform it actually owns:

```text
packages/android/
├── package.json                 # pnpm wrappers around frontend + Gradle tasks
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── gradlew / gradle/
└── app/
    ├── build/generated/webAssets/ # generated bundled-client input, not committed
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/yepanywhere/mobile/
        │   ├── MainActivity.kt
        │   ├── web/
        │   │   ├── WebClientActivity.kt
        │   │   ├── WebClientConfig.kt
        │   │   ├── WebClientNavigation.kt
        │   │   └── YaNativeMessageHost.kt
        │   └── notifications/
        │       └── YepFirebaseMessagingService.kt
        └── res/
```

`MainActivity` is the Compose-owned launcher and app-navigation root. During
the migration it may immediately enter `WebClientActivity`, preserving the
current foreground experience. Later it can show Compose onboarding, server
selection, inbox, and Conversation view while `WebClientActivity` stays the
full-screen **Open full activity** destination.

A dedicated activity keeps the complex full web client, its back stack, file
chooser, downloads, and WebView lifecycle out of native screen composition.
Compose does not need to pretend the WebView is a native screen, and the
WebView does not become the owner of app navigation. If physical testing shows
that a Compose-hosted `AndroidView` materially simplifies state handoff without
lifecycle regressions, that is an implementation alternative, not a reason to
restore a cross-platform shell.

Keep the Android application id `com.yepanywhere.mobile`. Renaming the source
workspace must not change Firebase registration, App Links, password-manager
association, stored app data, signing identity, or future Play update identity.
A later product decision may rename the package display or repository path
without changing this identity.

## Client Asset Channels

Preserve the existing channel decisions while replacing their implementation:

| Channel | Web client source | Native message origin |
| --- | --- | --- |
| Local/debug bundled | Current-checkout remote client copied into APK assets | `https://appassets.androidplatform.net` |
| Ordinary production | Bundled, release-approved client assets | `https://appassets.androidplatform.net` |
| Hosted `latest` testing | Fixed `https://latest.yepanywhere.com/` | Exact same HTTPS origin |
| Explicit debug override | Build-time URL supplied deliberately by the developer | Exact parsed origin for that debug build only |

The pnpm wrapper builds the web client before invoking Gradle. Gradle does not
discover or silently run an arbitrary package manager from an Android task.
Bundled builds copy the generated web artifact into the flavor's assets and
load it through `WebViewAssetLoader`; hosted builds package no client
JavaScript or CSS.

An explicit URL remains authoritative. Release builds reject debug URL
overrides, do not inherit `latest`, and do not fall back from an unavailable
hosted origin to another operator's endpoint. A hosted outage produces an
honest native retry/offline surface. Debug-only cleartext access, if retained,
uses an explicit build property and a debug network-security policy rather
than production-wide mixed-content or cleartext enablement.

Top-level WebView navigation is restricted to the configured app origin and
the YA routes it owns. Validate both scheme and normalized host. External HTTPS
links open in the system browser or a Custom Tab; `file:`, `content:`,
`javascript:`, unexpected custom schemes, and unapproved top-level origins do
not load in the privileged WebView. Bundled mode disables file and content
access and keeps mixed content disabled.

## Native Host Message Contract

### Feature detection

Do not add a global `isAndroid()` switch as the feature gate. Browsers, hosted
pages, future iOS, and Android should branch on the operation they need, not on
a user-agent or container label.

For approved origins, Android installs one raw message object before loading
the document:

```ts
window.yaNative
```

That object is the small `postMessage` / message-listener primitive supplied by
`WebViewCompat.addWebMessageListener`. Application code does not call it
directly. A client module such as `lib/nativeHost/` wraps it in promises,
validation, timeouts, and typed feature discovery:

```ts
const host = await nativeHost.describe();

if (host?.features.includes("notifications.enrollment.v1")) {
  // Render or invoke the supported operation.
}
```

The descriptor may report `platform: "android"` for copy, diagnostics, or
platform-specific presentation. It is not evidence that a particular
operation exists. In an ordinary browser `window.yaNative` is absent and the
adapter resolves to `null` without logging an error.

If the installed WebView does not support `WEB_MESSAGE_LISTENER`, the bridge is
unavailable and the web client remains usable. Do not fall back to
`addJavascriptInterface`, wildcard-origin message ports, or JavaScript URL
evaluation.

### Message envelope

The raw channel carries bounded JSON strings with a versioned request/response
shape:

```ts
type NativeHostRequest = {
  protocol: 1;
  id: string;
  method: string;
  params?: unknown;
};

type NativeHostResponse =
  | { protocol: 1; id: string; ok: true; result?: unknown }
  | {
      protocol: 1;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

type NativeHostEvent = {
  protocol: 1;
  event: string;
  payload?: unknown;
};
```

The first implemented method is `host.describe`. It returns the bridge
protocol, platform, app/build version, and an explicit feature-name list. Shell
removal does not need notification, filesystem, credential, network-proxy, or
generic navigation methods.

Unknown versions, methods, invalid JSON, duplicate request ids, non-object
parameters, and messages over 16 KiB of UTF-8 fail with a bounded error and no
native action. Responses use the message reply proxy; do not construct
JavaScript source or call `evaluateJavascript` with serialized payloads.

### Origin and document authority

Register the listener before `loadUrl` with an exact, build-derived
`allowedOriginRules` set. Never use `*` or a broad wildcard subdomain. The
native handler also verifies the supplied `sourceOrigin` and `isMainFrame` on
every message. An allowed iframe is not an app client and receives no native
authority.

The bridge belongs to the current top-level document. Navigation, renderer
replacement, activity destruction, and WebView destruction invalidate pending
requests and native event sinks. A later document must perform a new
`host.describe` handshake. Native events are delivered only after that
handshake; FCM receipt itself never creates a WebView merely to send an event.

An allowed hosted origin is trusted application code and could exercise every
method granted to it if compromised. Origin checks therefore complement rather
than replace least authority: methods remain high-level, argument validation
is repeated natively, native installation secrets never cross the channel,
and no generic native primitive is added for convenience.

## Deep Links And Launch Context

Preserve the verified `/open` App Link boundary and Digital Asset Links
metadata. Android parses and validates the incoming URI before selecting a
known app destination. A notification or external link cannot supply an
arbitrary WebView origin.

Replace the current Rust `window.eval` handoff with either a safely constructed
fixed-origin URL or a typed, opaque launch-context message after the WebView
handshake. Do not splice URL or credential text into executable JavaScript.
Changing the password-bearing deep-link contract or introducing passwordless
SRP pairing is outside this migration and requires its own security review.

## Server Compatibility Boundary

The Android shell and `host.describe` message require no YA server change. They
therefore add no server capability, route, field, or protocol-level dependency.
The full web client behaves normally when the native host is absent.

The later native push work remains gated by a new exact server capability. This
plan does not name or advertise that capability, create a destination, or let
the client make an unsupported request. Removing Tauri must not be bundled
with the separately approved native-push client/server contract.

## Continuous Integration Contract

Add a foreground-app Android workflow, separate from Device Bridge CI. It runs
for changes to `packages/android`, the client native-host adapter, shared build
inputs, or the workflow itself. The required jobs:

- install the repository's pinned Node/pnpm toolchain, Java 17, and Android SDK;
- run client native-host tests, Android JVM tests, and Android lint without
  warnings;
- build config-free bundled debug, ordinary bundled release, and hosted
  `latest` artifacts;
- inspect APK contents for each asset-channel contract and for the absence of
  Tauri/Rust runtime artifacts;
- run the bounded WebView/lifecycle instrumentation suite on an ephemeral CI
  emulator; and
- upload APKs and machine-readable test reports for failed-run diagnosis.

CI does not need relay credentials, YA production state, Firebase service
account credentials, or a persistent emulator. It must not contact the
maintainer's live YA server. Tests that need a YA runtime use a disposable
profile and an isolated port; WebView security tests prefer packaged fixtures
over mutable external pages. The physical-device matrix remains a release and
migration acceptance gate rather than pretending CI emulation proves FCM or
system-integration behavior.

## Migration Steps

### 1 — freeze the existing Android shell evidence

- Record warning-free build commands and artifact locations for bundled debug,
  ordinary bundled release, and hosted-`latest` release variants.
- Record the current package/application id, version inputs, min/target SDK,
  signing behavior, manifest permissions, App Link filters, Digital Asset
  Links metadata, Firebase dependencies, and conditional no-Firebase build.
- On the Pixel, record the current launch, back navigation, relay login,
  rotation/process recreation, App Link, and FCM diagnostic behavior without
  recording passwords, resume material, FIDs, or Firebase configuration.

### 2 — create the first-class Gradle and Compose shell

- Create `packages/android` with conventional Gradle ownership and a thin
  package.json command wrapper.
- Add a Compose-owned `MainActivity` and a dedicated `WebClientActivity`.
- Preserve `com.yepanywhere.mobile`, resources, icons, manifest metadata,
  signing inputs, Firebase BoM/version evidence, and the config-free source
  build.
- Keep the app single-process unless a measured Android requirement later
  justifies another process; FCM callbacks must not initialize WebView.

### 3 — reproduce the bundled and hosted client channels

- Serve generated bundled assets through `WebViewAssetLoader` at the reserved
  HTTPS app-assets origin.
- Express bundled, hosted-`latest`, and explicit debug origins as build
  configuration rather than runtime preference.
- Add strict top-level navigation, external-link, mixed-content, file/content
  access, Safe Browsing, cache, error, and renderer-recovery behavior.
- Prove that the hosted APK contains no client JavaScript/CSS and ordinary
  production still uses bundled assets.

### 4 — add the origin-bound native host channel

- Register `window.yaNative` with `addWebMessageListener` only for the exact
  build origins and main frame.
- Implement the protocol-1 envelope, bounded parser, reply path, lifecycle
  cancellation, and `host.describe` only.
- Add the client-side adapter and browser-absence tests. Do not introduce
  Android UI branching outside that adapter.
- Prove disallowed origins, subframes, unknown methods, and stale documents
  cannot invoke native behavior.

### 5 — migrate App Links and the Firebase receive probe

- Move the current `YepFirebaseMessagingService` into the first-class source
  tree without adding broker upload, polling, or user-visible notification
  behavior.
- Preserve configured and config-free builds plus the existing debug-only,
  non-secret diagnostic boundary.
- Replace executable-string deep-link injection with validated native routing
  and a typed/safely encoded web handoff.
- Confirm FCM receipt with the activity and WebView absent.

### 6 — remove Tauri Mobile and generated-project ownership

- Delete the mobile `src-tauri`, Cargo manifests/lockfile, generated Android
  host, Tauri CLI dependency, Tauri build scripts, Tauri capability files, and
  mobile iOS command placeholders only after replacement evidence passes.
- Rename workspace references from `@yep-anywhere/mobile` to
  `@yep-anywhere/android`; update the pnpm lockfile, typecheck/lint exclusions,
  public distribution evidence, and current mobile documentation.
- Remove client logic that recognizes packaged Tauri mobile origins only after
  the app-assets replacement has an equivalent service-worker exclusion.
- Do not change `packages/desktop`, desktop Tauri dependencies, desktop auth,
  updater, installer, or desktop documentation.

### 7 — add foreground Android CI

- Add the dedicated workflow described by the continuous-integration contract;
  do not extend Device Bridge CI and imply that it validates the app.
- Make Kotlin JVM tests, client native-host tests, Android lint, channel builds,
  APK inspection, and emulator instrumentation required jobs.
- Keep the build config-free and upload diagnostic reports and APK artifacts
  without Firebase material or user state.
- Ensure root typechecking no longer silently excludes the replacement Android
  workspace's TypeScript-facing code.

### 8 — prove the first-class Android shell on connected Android

- Build and install bundled debug, config-free debug, ordinary bundled
  release, and hosted-`latest` release artifacts without Cargo, Rust, the NDK,
  or Tauri CLI participation.
- Prefer an attached, authorized physical device and select it explicitly. If
  none is attached, use any existing local AVD, including the
  `jstorrent-*` AVDs, and mark physical-only rows pending rather than treating
  emulator output as FCM/system-integration proof.
- Verify the launcher, process recreation, rotation, back handling, WebView
  state, hosted outage state, external navigation, App Link, password-manager
  metadata, and FCM receive probe on the Pixel.
- Verify ordinary browsers see no native host, approved app origins receive
  only `host.describe`, disallowed origins/subframes receive nothing, and no
  bridge message or page navigation prints secrets.
- Inspect the APK to confirm the intended asset channel and absence of Tauri
  and Rust runtime artifacts.

### 9 — hand the shell to notifications and Compose onboarding

- Update the Android wrapper/notification plan with the verified native-host
  feature names and build commands.
- Begin app-private broker installation storage and event-driven FID
  replacement only after this plan is complete.
- Present and approve the separate YA-server native-push capability contract
  before implementing server enrollment.
- Plan Compose installation guidance and passwordless QR/SRP pairing as
  explicit user journeys with their own security and compatibility contracts;
  do not hide them inside the WebView host migration.

## Verification Commands

The implementation should provide stable package wrappers for at least:

```text
pnpm --filter @yep-anywhere/android dev:android
pnpm --filter @yep-anywhere/android build:android:debug
pnpm --filter @yep-anywhere/android build:android
pnpm --filter @yep-anywhere/android build:android:hosted-latest
pnpm --filter @yep-anywhere/android test
pnpm --filter @yep-anywhere/android lint
```

The Android wrappers should run the applicable Gradle unit tests, lint, and
build tasks without warnings introduced by the migration. Instrumentation on
the attached physical device, or an existing local AVD when no device is
available, covers WebView origin enforcement, main-frame enforcement, and
back/lifecycle behavior. The physical device covers the existing FCM probe.
Repository lint, typecheck, client native-host adapter tests, CI emulator, APK
inspection, and build-channel checks remain part of the final gate.

## Exit Result

This plan is complete when the Android app is a conventional Gradle/Kotlin
application, Compose owns its launcher/navigation root, the existing full web
client works through explicitly configured bundled and hosted channels, and
the only web/native authority is an exact-origin protocol-1 message host with
`host.describe`. The Pixel must retain current App Link and FCM probe behavior,
and no mobile build may depend on Tauri, Rust, Cargo, or generated Tauri
project ownership. The dedicated Android CI workflow must independently prove
the deterministic unit, build, inspection, and emulator contracts, while the
recorded physical-device run proves the system integration that CI cannot.
