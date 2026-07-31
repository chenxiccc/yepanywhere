# Android Credential Sharing

> Associate the packaged Android app with `yepanywhere.com` so compatible
> password managers can offer existing Remote Access credentials in the app.

Topic: android-credential-sharing

## Status

The two-way Digital Asset Links declarations are implemented and live-verified
for the current Android debug build. Google Autofill finds a credential dataset
for the relay login, but sideloaded password-manager behavior remains an
experiment until the app has a public Play release.

## Observable Contract

- The website serves
  `https://yepanywhere.com/.well-known/assetlinks.json` directly over HTTPS with
  a JSON content type and no redirect.
- The statement list declares password credential sharing between
  `https://yepanywhere.com` and the Android package
  `com.yepanywhere.mobile`.
- The Android app includes that statement list through its application
  metadata.
- The existing relay and direct login forms continue to expose the standard
  `username` and `current-password` autocomplete hints.
- App Link authorization remains bounded by the Android manifest. The app's
  current verified-link intent filter handles only `/open` routes.
- A missing, unreachable, malformed, or certificate-mismatched statement fails
  closed: Android does not treat the app and website as associated.
- Credential suggestions remain under the installed password manager's control.
  YA does not read, export, or broker stored password-manager data.

## Debug-Build Scope

The initial website statement names the SHA-256 certificate fingerprint of the
maintainer debug APK used for live-device development. It therefore matches
only APKs signed by that same debug key. A source build signed by a different
developer's debug key is not associated.

The certificate fingerprint is public identity material; its private signing
key is not published. Nevertheless, a debug signing key is not a production
trust anchor. Before a public Android release, add the official distribution
certificate and remove the debug fingerprint unless there is a deliberate need
to retain maintainer-build association.

Google Password Manager documents public Play publication as a prerequisite for
cross-app credential sharing. The debug association is therefore useful for
validating the Digital Asset Links chain and testing password managers that
honor manual associations, but it is not a guarantee that Google Password
Manager will offer the website password in a sideloaded build.

## Verification

For each website release:

1. Confirm the URL returns HTTP 200, `Content-Type: application/json`, and no
   redirect.
   The deployment artifact must copy hidden static directories; a wildcard
   such as `site/dist/*` omits `.well-known`. Artifact uploaders that exclude
   hidden files by default must also be explicitly opted into them.
2. Check both credential-sharing statements through the Digital Asset Links
   API or validator.
3. Verify the APK's signing certificate matches the published fingerprint.
4. Reinstall the APK, request Android App Links re-verification, and inspect the
   package's domain state.
5. Let the user test the configured password manager on the relay login form;
   automated tooling must not inspect or disclose saved credentials.

## Debug Live Verification

Completed on 2026-07-31 with the maintainer-signed debug APK and an attached
Pixel 9 running Android 17:

1. Published the two-way statements through `site-v1.8.3` and confirmed the
   production URL returns HTTP 200, a JSON content type, no redirect, and the
   exact checked-in body.
2. Downloaded the Pages artifact and confirmed it contains both
   `.well-known` association files. Earlier `site-v1.8.1` and `site-v1.8.2`
   runs exposed and then closed separate hidden-directory copy and upload
   omissions.
3. Reinstalled the matching debug APK without clearing app data. Android domain
   verification moved from the previously cached verifier error to `verified`.
4. Confirmed the WebView exposes `relayUsername` as an editable field and
   `srpPassword` as a password field.
5. Focused the relay login fields and inspected only system Autofill metadata.
   Google Autofill recorded a successful response with one dataset for
   `com.yepanywhere.mobile`; inline suggestions were enabled. Automation did
   not print credential labels or values and did not submit a login.

This proves the website/app association and suggestion lookup on the debug
device. A user selection and successful field fill remain the final manual
check because selecting a password-manager dataset can expose account data or
require device authentication.

## Production Follow-Up

- Decide the supported signing/distribution path and publish its certificate
  fingerprint.
- Publish the app through the required public Play channel before treating
  Google Password Manager sharing as supported behavior.
- Re-test credential suggestions with a release-signed build and record the
  password-manager/device matrix.
