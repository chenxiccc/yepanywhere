// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePushNotifications } from "../usePushNotifications";

const mocks = vi.hoisted(() => ({
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
});
