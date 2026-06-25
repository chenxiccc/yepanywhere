import { useCallback, useEffect, useState } from "react";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";

/**
 * Read the notifyInApp setting from localStorage
 */
function getNotifyInAppSetting(): boolean {
  return getServerScoped("notifyInApp", LEGACY_KEYS.notifyInApp) === "true";
}

/**
 * Sync a setting to the service worker via postMessage
 */
function syncSettingToSW(key: string, value: boolean) {
  if (!("serviceWorker" in navigator)) return;

  const msg = { type: "setting-update", key, value };

  // Sync to current controller if available
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  }

  // Also sync when SW becomes ready (handles SW restarts)
  navigator.serviceWorker.ready.then((registration) => {
    registration.active?.postMessage(msg);
  });
}

/**
 * Sync the notifyInApp setting to the service worker
 */
function syncNotifyInAppToServiceWorker(value: boolean) {
  syncSettingToSW("notifyInApp", value);
}

/**
 * Sync page visibility (document.hidden) to the service worker.
 * 主线程同步页面可见性给 SW，解决手机锁屏时 client.focused 不可靠的问题。
 * The main thread syncs page visibility to the SW, fixing the problem where
 * client.focused is unreliable when the phone is locked.
 */
function syncPageVisibilityToServiceWorker() {
  const isVisible = typeof document !== "undefined" && !document.hidden;
  syncSettingToSW("isPageVisible", isVisible);
}

/**
 * Hook to sync notifyInApp setting and page visibility to service worker
 * on app startup. Call this at the app level.
 */
export function useSyncNotifyInAppSetting() {
  useEffect(() => {
    const value = getNotifyInAppSetting();
    syncNotifyInAppToServiceWorker(value);

    // Sync page visibility on startup
    syncPageVisibilityToServiceWorker();

    // Also handle when a new service worker takes over
    if ("serviceWorker" in navigator) {
      const handleControllerChange = () => {
        syncNotifyInAppToServiceWorker(getNotifyInAppSetting());
        syncPageVisibilityToServiceWorker();
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        handleControllerChange,
      );
      return () => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          handleControllerChange,
        );
      };
    }
  }, []);
}

/**
 * Hook to sync page visibility to the service worker in real-time.
 * 监听 visibilitychange 事件，实时同步页面可见性给 SW。
 * When the page becomes hidden (phone locked, app backgrounded), the SW
 * will always show notifications regardless of client.focused state.
 */
export function useSyncPageVisibility() {
  useEffect(() => {
    if (typeof document === "undefined" || !("serviceWorker" in navigator))
      return;

    const handleVisibilityChange = () => {
      syncPageVisibilityToServiceWorker();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Sync initial state
    syncPageVisibilityToServiceWorker();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}

/**
 * Hook to manage the "notify when in app" setting.
 * When enabled, notifications will show even when the app is focused,
 * as long as the specific session isn't being viewed.
 */
export function useNotifyInApp() {
  const [notifyInApp, setNotifyInAppState] = useState(getNotifyInAppSetting);

  // Sync setting to service worker whenever it changes
  useEffect(() => {
    syncNotifyInAppToServiceWorker(notifyInApp);
  }, [notifyInApp]);

  const setNotifyInApp = useCallback((value: boolean) => {
    setServerScoped("notifyInApp", String(value), LEGACY_KEYS.notifyInApp);
    setNotifyInAppState(value);
  }, []);

  return { notifyInApp, setNotifyInApp };
}