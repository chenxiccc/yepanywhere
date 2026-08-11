import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { toBrowserAssetHref } from "../lib/appHref";
import {
  BROWSER_LOCAL_KEYS,
  getOrCreateBrowserProfileId,
} from "../lib/storageKeys";
import {
  notifyPushSubscriptionChanged,
  PUSH_SUBSCRIPTION_CHANGED_EVENT,
  type PushDeliveryUrgency,
  type TestNotificationUrgency,
} from "./useSubscribedDevices";
// Use Vite's base URL - in production remote build this is /remote/
const SW_PATH = toBrowserAssetHref("sw.js");

// In production, SW is always enabled
// In dev mode, check server setting (allows runtime toggle via settings UI)
const IS_DEV = import.meta.env.DEV;
const NOTIFICATION_PERMISSION_REQUEST_TIMEOUT_MS = 60_000;

export const PUSH_PERMISSION_REQUEST_TIMED_OUT =
  "push-permission-request-timed-out";

class NotificationPermissionRequestTimeoutError extends Error {}

interface PushState {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  permission: NotificationPermission;
  browserProfileId: string | null;
}

/**
 * Hook for managing push notification subscriptions.
 *
 * Handles:
 * - Service worker registration
 * - Push subscription management
 * - Browser profile ID generation/persistence
 * - Server sync
 */
export function usePushNotifications() {
  const [state, setState] = useState<PushState>({
    isSupported: false,
    isSubscribed: false,
    isLoading: true,
    error: null,
    permission: "default",
    browserProfileId: null,
  });

  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const permissionRequestReconcilerRef = useRef<
    ((permission: NotificationPermission) => void) | null
  >(null);

  // Check browser API support (separate from server-side enablement)
  const hasBrowserSupport =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // Initialize: check server setting (in dev mode), then register service worker
  useEffect(() => {
    const init = async () => {
      // Check browser support first
      if (!hasBrowserSupport) {
        const browserProfileId = localStorage.getItem(
          BROWSER_LOCAL_KEYS.browserProfileId,
        );
        setState((s) => ({
          ...s,
          isSupported: false,
          isLoading: false,
          error: "Push notifications not supported in this browser",
          browserProfileId,
        }));
        return;
      }

      // In dev mode, check server setting
      if (IS_DEV) {
        try {
          const response = await api.getServerSettings();
          if (!response.settings.serviceWorkerEnabled) {
            const browserProfileId = localStorage.getItem(
              BROWSER_LOCAL_KEYS.browserProfileId,
            );
            setState((s) => ({
              ...s,
              isSupported: false,
              isLoading: false,
              error:
                "Service worker disabled (enable in Settings > Development)",
              browserProfileId,
            }));
            return;
          }
        } catch (err) {
          // If settings fetch fails, continue with SW enabled (fail open)
          console.warn(
            "[usePushNotifications] Failed to fetch server settings, proceeding with SW enabled:",
            err,
          );
        }
      }

      // Register service worker
      try {
        const reg = await navigator.serviceWorker.register(SW_PATH);
        setRegistration(reg);

        // Wait for service worker to be ready
        await navigator.serviceWorker.ready;

        // Check current subscription status
        const subscription = await reg.pushManager.getSubscription();
        const browserProfileId = getOrCreateBrowserProfileId();

        setState({
          isSupported: true,
          isSubscribed: !!subscription,
          isLoading: false,
          error: null,
          permission: Notification.permission,
          browserProfileId,
        });
      } catch (err) {
        console.error("[usePushNotifications] Init error:", err);
        setState((s) => ({
          ...s,
          isSupported: true,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to initialize",
        }));
      }
    };

    init();
  }, [hasBrowserSupport]);

  // Multiple settings components consume this hook independently. Reconcile
  // each instance when one of them changes the browser-local subscription so
  // the toggle and device inventory cannot disagree until a reload.
  useEffect(() => {
    if (!registration) return;

    let disposed = false;
    const handleSubscriptionChange = async () => {
      try {
        const subscription = await registration.pushManager.getSubscription();
        if (disposed) return;
        setState((current) => ({
          ...current,
          isSubscribed: !!subscription,
          isLoading: false,
          error: null,
        }));
      } catch (err) {
        if (disposed) return;
        setState((current) => ({
          ...current,
          isLoading: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to refresh subscription",
        }));
      }
    };

    window.addEventListener(
      PUSH_SUBSCRIPTION_CHANGED_EVENT,
      handleSubscriptionChange,
    );
    return () => {
      disposed = true;
      window.removeEventListener(
        PUSH_SUBSCRIPTION_CHANGED_EVENT,
        handleSubscriptionChange,
      );
    };
  }, [registration]);

  // Permission can change in browser chrome while YA is backgrounded. Keep
  // the displayed permission aligned when the document becomes active again.
  useEffect(() => {
    if (!hasBrowserSupport) return;

    const reconcilePermission = () => {
      const permission = Notification.permission;
      if (permission !== "default") {
        permissionRequestReconcilerRef.current?.(permission);
      }
      setState((current) => {
        if (permission === current.permission) return current;
        return {
          ...current,
          permission,
          error:
            permission === "granted" &&
            current.error === PUSH_PERMISSION_REQUEST_TIMED_OUT
              ? null
              : current.error,
        };
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcilePermission();
    };

    window.addEventListener("focus", reconcilePermission);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", reconcilePermission);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [hasBrowserSupport]);

  const requestNotificationPermission = useCallback(async () => {
    let timeoutId: number | undefined;
    try {
      return await Promise.race([
        Notification.requestPermission(),
        new Promise<NotificationPermission>((resolve) => {
          permissionRequestReconcilerRef.current = resolve;
        }),
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new NotificationPermissionRequestTimeoutError());
          }, NOTIFICATION_PERMISSION_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      permissionRequestReconcilerRef.current = null;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }, []);

  // Subscribe to push notifications
  const subscribe = useCallback(async () => {
    if (!registration) {
      setState((s) => ({ ...s, error: "Service worker not ready" }));
      return;
    }

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Request notification permission
      const permission = await requestNotificationPermission();
      setState((s) => ({ ...s, permission }));

      if (permission !== "granted") {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: "Notification permission denied",
        }));
        return;
      }

      // Get VAPID public key from server
      const { publicKey } = await api.getPushPublicKey();

      // Convert base64url to Uint8Array for applicationServerKey
      const applicationServerKey = urlBase64ToUint8Array(publicKey);

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
      });

      // Send subscription to server
      const browserProfileId = getOrCreateBrowserProfileId();
      const subscriptionJson = subscription.toJSON();

      await api.subscribePush(
        browserProfileId,
        subscriptionJson as PushSubscriptionJSON,
        getDeviceName(),
      );

      setState((s) => ({
        ...s,
        isSubscribed: true,
        isLoading: false,
        error: null,
        browserProfileId,
      }));
      notifyPushSubscriptionChanged();
    } catch (err) {
      if (err instanceof NotificationPermissionRequestTimeoutError) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: PUSH_PERMISSION_REQUEST_TIMED_OUT,
        }));
        return;
      }
      console.error("[usePushNotifications] Subscribe error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to subscribe",
      }));
    }
  }, [registration, requestNotificationPermission]);

  // Unsubscribe from push notifications
  const unsubscribe = useCallback(async () => {
    if (!registration) {
      setState((s) => ({ ...s, error: "Service worker not ready" }));
      return;
    }

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Get current subscription
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Unsubscribe locally
        await subscription.unsubscribe();
      }

      // Notify server
      const browserProfileId = getOrCreateBrowserProfileId();
      await api.unsubscribePush(browserProfileId);

      setState((s) => ({
        ...s,
        isSubscribed: false,
        isLoading: false,
        error: null,
      }));
      notifyPushSubscriptionChanged();
    } catch (err) {
      console.error("[usePushNotifications] Unsubscribe error:", err);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to unsubscribe",
      }));
    }
  }, [registration]);

  // Send a test notification. Returns true if the server accepted it.
  const sendTest = useCallback(
    async (
      urgency: TestNotificationUrgency = "normal",
      deliveryUrgency: PushDeliveryUrgency = "high",
    ): Promise<boolean> => {
      const browserProfileId = getOrCreateBrowserProfileId();
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        await api.testPush(
          browserProfileId,
          undefined,
          urgency,
          deliveryUrgency,
        );
        setState((s) => ({ ...s, isLoading: false }));
        return true;
      } catch (err) {
        console.error("[usePushNotifications] Test push error:", err);
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to send test",
        }));
        return false;
      }
    },
    [],
  );

  // Get service worker logs (for debugging)
  const getSwLogs = useCallback(async (): Promise<SwLogEntry[]> => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) {
      console.warn("[usePushNotifications] No active service worker");
      return [];
    }

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        resolve(event.data?.logs || []);
      };
      sw.postMessage({ type: "get-sw-logs" }, [channel.port2]);

      // Timeout after 2 seconds
      setTimeout(() => resolve([]), 2000);
    });
  }, []);

  // Clear service worker logs
  const clearSwLogs = useCallback(async (): Promise<void> => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      sw.postMessage({ type: "clear-sw-logs" }, [channel.port2]);
      setTimeout(resolve, 1000);
    });
  }, []);

  return {
    ...state,
    subscribe,
    unsubscribe,
    sendTest,
    getSwLogs,
    clearSwLogs,
  };
}

export interface SwLogEntry {
  id?: number;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  data: Record<string, unknown>;
}

/**
 * Convert a base64url-encoded string to a Uint8Array.
 * Used for the applicationServerKey in pushManager.subscribe().
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  // Add padding if needed
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

/**
 * Generate a friendly device name based on user agent.
 */
function getDeviceName(): string {
  const ua = navigator.userAgent;

  // Try to extract a meaningful name
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";

  return "Browser";
}
