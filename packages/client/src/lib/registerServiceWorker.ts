/**
 * Register Service Worker at startup to enable PWA capabilities (install, etc.)
 * out of the box, without requiring the user to visit notification settings first.
 *
 * Decoupled from push subscription: SW registration is PWA infrastructure
 * needed by all users; push subscription is opt-in.
 */
import { api } from "../api/client";
import { toBrowserAssetHref } from "./appHref";
import { isRemoteClient } from "./connection";

/** Service Worker file path, compatible with Vite base URL (local "/" and remote "/remote/") */
const SW_PATH = toBrowserAssetHref("sw.js");

/** Whether the current browser supports Service Worker. */
function hasBrowserSupport(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

/** Packaged app assets use a local trusted origin, not a browser PWA origin. */
export function isPackagedAppOrigin(location: {
  hostname: string;
  protocol: string;
}): boolean {
  return (
    location.hostname === "tauri.localhost" ||
    location.protocol === "tauri:" ||
    location.hostname === "appassets.androidplatform.net"
  );
}

/**
 * Register Service Worker at application startup.
 * Only registers the SW itself, does not subscribe to push notifications.
 */
export async function registerServiceWorkerAtStartup(): Promise<void> {
  if (!hasBrowserSupport()) return;
  if (isPackagedAppOrigin(window.location)) return;

  // In dev mode, check server setting (allows runtime toggle via settings UI)
  if (import.meta.env.DEV) {
    // The remote dev client is served by Vite before SRP authentication, so it
    // has no same-origin API to query without bypassing the secure transport.
    if (isRemoteClient()) return;

    try {
      const response = await api.getServerSettings();
      if (!response.settings.serviceWorkerEnabled) {
        console.log(
          "[registerServiceWorker] Service worker disabled by server setting",
        );
        return;
      }
    } catch (err) {
      // In dev, respect the settings gate when it cannot be read. This avoids
      // re-registering SW on unauthenticated startup or while debugging reloads.
      console.warn(
        "[registerServiceWorker] Failed to fetch server settings, skipping SW registration",
        err,
      );
      return;
    }
  }

  try {
    // Calling register() on an already-registered SW returns the existing registration
    const reg = await navigator.serviceWorker.register(SW_PATH);
    // Playwright returns undefined when the context intentionally blocks
    // service workers. That is an expected no-registration result.
    if (!reg) return;
    console.log(
      "[registerServiceWorker] Service worker registered:",
      reg.scope,
    );
  } catch (err) {
    console.error("[registerServiceWorker] Failed to register:", err);
  }
}
