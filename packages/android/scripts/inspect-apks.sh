#!/usr/bin/env bash

set -euo pipefail

android_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundled_apk="${1:-${android_dir}/app/build/outputs/apk/bundled/release/app-bundled-release-unsigned.apk}"
hosted_apk="${2:-${android_dir}/app/build/outputs/apk/hostedLatest/release/app-hostedLatest-release-unsigned.apk}"

fail() {
  echo "APK contract failed: $*" >&2
  exit 1
}

for apk in "$bundled_apk" "$hosted_apk"; do
  test -f "$apk" || fail "missing $apk"
done

find_apkanalyzer() {
  if command -v apkanalyzer >/dev/null 2>&1; then
    command -v apkanalyzer
    return
  fi

  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -n "$sdk_root" && -x "$sdk_root/cmdline-tools/latest/bin/apkanalyzer" ]]; then
    echo "$sdk_root/cmdline-tools/latest/bin/apkanalyzer"
    return
  fi

  fail "apkanalyzer is not available"
}

apkanalyzer="$(find_apkanalyzer)"
bundled_entries="$(unzip -Z1 "$bundled_apk")"
hosted_entries="$(unzip -Z1 "$hosted_apk")"

grep -qx 'assets/index.html' <<<"$bundled_entries" ||
  fail "bundled APK has no client index"
grep -Eq '^assets/.*\.js$' <<<"$bundled_entries" ||
  fail "bundled APK has no client JavaScript"
grep -Eq '^assets/.*\.css$' <<<"$bundled_entries" ||
  fail "bundled APK has no client CSS"

if grep -Eqi '^assets/.*\.(html|js|css|map)$' <<<"$hosted_entries"; then
  fail "hosted APK contains web client source"
fi

for entries in "$bundled_entries" "$hosted_entries"; do
  if grep -Eqi '(^|/)(tauri|wry|cargo|rust)([^/]*)(/|$)' <<<"$entries"; then
    fail "APK contains a Tauri or Rust artifact"
  fi

  unexpected_native="$(
    grep -E '^lib/.*\.so$' <<<"$entries" |
      grep -Ev '^lib/(arm64-v8a|armeabi-v7a|x86|x86_64)/(libandroidx\.graphics\.path|libdatastore_shared_counter|libjnidispatch|libsodium)\.so$' ||
      true
  )"
  [[ -z "$unexpected_native" ]] ||
    fail "APK contains an unreviewed native library: ${unexpected_native}"

  for abi in arm64-v8a armeabi-v7a x86 x86_64; do
    grep -qx "lib/${abi}/libjnidispatch.so" <<<"$entries" ||
      fail "APK is missing JNA for ${abi}"
    grep -qx "lib/${abi}/libsodium.so" <<<"$entries" ||
      fail "APK is missing libsodium for ${abi}"
  done
done

for apk in "$bundled_apk" "$hosted_apk"; do
  application_id="$($apkanalyzer manifest application-id "$apk")"
  [[ "$application_id" == "com.yepanywhere.mobile" ]] ||
    fail "unexpected application id in $apk: $application_id"

  manifest="$($apkanalyzer manifest print "$apk")"
  grep -q 'android:name="android.permission.POST_NOTIFICATIONS"' <<<"$manifest" ||
    fail "notification permission is missing from $apk"
  grep -q 'android:name="com.google.firebase.messaging.default_notification_icon"' <<<"$manifest" ||
    fail "default notification icon is missing from $apk"
  grep -q 'android:name="asset_statements"' <<<"$manifest" ||
    fail "Digital Asset Links metadata is missing from $apk"
  grep -q 'android:scheme="https"' <<<"$manifest" ||
    fail "HTTPS App Link is missing from $apk"
  grep -q 'android:host="yepanywhere.com"' <<<"$manifest" ||
    fail "App Link host is missing from $apk"
  grep -q 'android:path="/open"' <<<"$manifest" ||
    fail "exact App Link path is missing from $apk"
done

echo "Android APK contracts passed."
