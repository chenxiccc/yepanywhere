// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUSH_PERMISSION_REQUEST_TIMED_OUT,
  usePushNotifications,
} from "../usePushNotifications";

const mocks = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  getServerSettings: vi.fn(),
  unsubscribePush: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: mocks,
}));

describe("usePushNotifications", () => {
  let subscription: { unsubscribe: ReturnType<typeof vi.fn> } | null;
  let serviceWorkerDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    subscription = {
      unsubscribe: vi.fn(async () => {
        subscription = null;
        return true;
      }),
    };
    mocks.getServerSettings.mockReset();
    mocks.getServerSettings.mockResolvedValue({
      settings: { serviceWorkerEnabled: true },
    });
    mocks.getPushPublicKey.mockReset();
    mocks.getPushPublicKey.mockResolvedValue({ publicKey: "AQ" });
    mocks.unsubscribePush.mockReset();
    mocks.unsubscribePush.mockResolvedValue({
      success: true,
      browserProfileId: "profile-1",
    });

    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => subscription),
      },
    } as unknown as ServiceWorkerRegistration;
    serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn(async () => "granted"),
    });
    localStorage.setItem("yep-anywhere-device-id", "profile-1");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
    if (serviceWorkerDescriptor) {
      Object.defineProperty(
        navigator,
        "serviceWorker",
        serviceWorkerDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("synchronizes independent hook consumers after local removal", async () => {
    const { result } = renderHook(() => ({
      inventory: usePushNotifications(),
      toggle: usePushNotifications(),
    }));

    await waitFor(() => {
      expect(result.current.inventory.isSubscribed).toBe(true);
      expect(result.current.toggle.isSubscribed).toBe(true);
    });

    await act(async () => {
      await result.current.inventory.unsubscribe();
    });

    await waitFor(() => {
      expect(result.current.inventory.isSubscribed).toBe(false);
      expect(result.current.toggle.isSubscribed).toBe(false);
    });
    expect(mocks.unsubscribePush).toHaveBeenCalledWith("profile-1");
  });

  it("recovers when the browser permission request never settles", async () => {
    subscription = null;
    let resolvePermission:
      | ((permission: NotificationPermission) => void)
      | undefined;
    vi.mocked(Notification.requestPermission).mockReturnValue(
      new Promise<NotificationPermission>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    const { result } = renderHook(() => usePushNotifications());

    await waitFor(() => {
      expect(result.current.isSupported).toBe(true);
      expect(result.current.isLoading).toBe(false);
    });

    vi.useFakeTimers();
    let subscribePromise: Promise<void> | undefined;
    act(() => {
      subscribePromise = result.current.subscribe();
    });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await subscribePromise;
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(PUSH_PERMISSION_REQUEST_TIMED_OUT);

    await act(async () => {
      resolvePermission?.("granted");
      await Promise.resolve();
    });
    expect(mocks.getPushPublicKey).not.toHaveBeenCalled();
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toBe(PUSH_PERMISSION_REQUEST_TIMED_OUT);
  });

  it("settles a pending request from permission changed in browser settings", async () => {
    Object.assign(Notification, { permission: "default" });
    vi.mocked(Notification.requestPermission).mockReturnValue(
      new Promise<NotificationPermission>(() => {}),
    );
    const { result } = renderHook(() => usePushNotifications());

    await waitFor(() => {
      expect(result.current.permission).toBe("default");
      expect(result.current.isLoading).toBe(false);
    });

    let subscribePromise: Promise<void> | undefined;
    act(() => {
      subscribePromise = result.current.subscribe();
    });
    Object.assign(Notification, { permission: "denied" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await subscribePromise;
    });

    expect(result.current.permission).toBe("denied");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("Notification permission denied");
  });
});
