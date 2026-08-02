# Android FCM Live Smoke

Status: implemented and verified.

Topic: android-fcm-push

## Origin

The credential-free push-broker milestone left its Android and live Firebase
boundaries intentionally untested. This milestone proves the smallest useful
next slice: the existing Android shell can register through the current
Firebase Installation ID (FID) API and receive a direct Firebase Console test
message on a physical device.

This is a registration and delivery probe, not the YA push product. It does
not connect the Android app to the push broker or add a YA client/server
contract.

## Android Probe Contract

The probe now lives in the first-class Android project:

- applies Google Services only when
  `packages/android/app/google-services.json` exists;
- ignores that project-specific file in Git and builds without it, reporting
  that Firebase messaging is disabled;
- pins Google Services plugin `4.5.0`, Firebase BoM `34.16.0`, and the BoM's
  Firebase Messaging `25.1.1`;
- opts into FID targeting with
  `firebase_messaging_installation_id_enabled`;
- registers a non-exported `FirebaseMessagingService`;
- declares Android notification permission but does not prompt for it; and
- relies on Firebase auto-initialization rather than an activity-owned
  registration call, retry loop, or background job.

The current service is deliberately diagnostic. Debug builds log the FID from
`onRegistered()` and, when a foreground message arrives, only its sorted data
key names and whether it contains a notification. It does not log notification
title/body text. Release builds do not log the FID or received-message
metadata.

The service does not yet upload the FID, display an app-owned notification,
fetch YA state, or maintain broker installation/subscription capabilities.

## Live Verification

Completed on 2026-07-31 with a developer-owned Firebase project and an
attached Pixel 9 running Android 17:

1. Registered the existing `com.yepanywhere.mobile` package as an Android
   Firebase app and kept the downloaded configuration local and ignored.
2. Built and installed a configured debug APK.
3. Confirmed a fresh launch invoked `onRegistered()` with an FID.
4. Sent `Yep Anywhere test` / `FCM is connected.` from the Firebase Console
   to that FID.
5. Confirmed the Firebase messaging service received one message while the app
   UI was in the foreground.
6. Removed the temporary explicit `register()` diagnostic.
7. Cleared only the dev app's local data and launched again.
8. Confirmed auto-initialization issued a different FID without activity code.
9. Built the debug APK again with `google-services.json` absent and confirmed
   the config-free source-build path still succeeds.

The old FID becoming obsolete after app-data clearing is expected. This test
does not claim that offline refresh, broker target replacement, provider 404
handling, or stale-record cleanup is complete.

The build retained existing Tauri/generated Android deprecation warnings and
the established frontend build advisories. The added Kotlin service emitted no
compiler warning.

The 2026-08-02 first-class-shell follow-up removed those Android build warnings
and repeated the probe on a Pixel 7a running Android 17 / API 37. A direct
Firebase Console test reached the replacement service once. The public broker
then produced one foreground callback and one background system notification;
the background send began with no YA Activity, WebView, or process alive. The
test used only temporary broker capabilities and retained no FID or secret.

## Stop Conditions

This milestone stops before:

- creating or using Firebase service-account credentials;
- sending through the live push-broker FCM adapter;
- adding Android-to-broker registration or capability storage;
- adding YA server routes, storage, or notification submissions;
- presenting the required stable-release compatibility review for that future
  YA client/server contract;
- requesting notification permission in product UI;
- implementing background-tray rendering or notification deep links;
- defining descriptive notification consent; or
- deploying the broker or app.

## Follow-On

1. Exercise the broker's FCM adapter with Application Default Credentials and
   a current physical-device FID.
2. Record observed FCM success, invalid-target, and transient-failure behavior
   before changing broker retry or cleanup policy.
3. Present the YA client/server compatibility plan and fallback before adding
   enrollment or send routes.
4. Implement Android broker enrollment and FID replacement through the
   approved contract, keeping SDK lifecycle ownership and no polling loop.
