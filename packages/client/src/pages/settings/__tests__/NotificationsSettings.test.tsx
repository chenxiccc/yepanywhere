// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSettings } from "../NotificationsSettings";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../components/PushNotificationToggle", () => ({
  PushNotificationToggle: () => <div>browser-subscription-control</div>,
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  subscribed: true,
}));

vi.mock("../../../hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({ browserProfileId: "profile-1" }),
}));

vi.mock("../../../hooks/useSubscribedDevices", () => ({
  useSubscribedDevices: () => ({
    devices: hookState.subscribed
      ? [
          {
            browserProfileId: "profile-1",
            createdAt: "2026-07-31T12:00:00.000Z",
            deviceName: "Work laptop",
            endpointDomain: "fcm.googleapis.com",
            deviceType: "desktop",
          },
        ]
      : [],
    isLoading: false,
    removeDevice: vi.fn(),
    sendTest: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useConnectedDevices", () => ({
  useConnectedDevices: () => ({
    connections: new Map([
      ["profile-1", { connectionCount: 1, deviceName: "Work laptop" }],
    ]),
    isLoading: false,
  }),
}));

vi.mock("../../../hooks/useNotificationSettings", () => ({
  useNotificationSettings: () => ({
    settings: {
      toolApproval: true,
      userQuestion: true,
      sessionHalted: false,
      projectInactive: false,
      yaInactive: false,
    },
    isLoading: false,
    updateSetting: vi.fn(),
  }),
}));

describe("NotificationsSettings", () => {
  beforeEach(() => {
    hookState.subscribed = true;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("presents one browser delivery path with event and device sections", () => {
    render(<NotificationsSettings />);

    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "notificationsThisBrowserTitle",
      "notificationsEventsTitle",
      "notificationsDevicesTitle",
    ]);
    expect(screen.getByText("browser-subscription-control")).toBeTruthy();
    expect(screen.queryByText("notificationsDesktopTitle")).toBeNull();
    expect(screen.queryByText("notificationsPushTitle")).toBeNull();
  });

  it("keeps test-only delivery controls collapsed by default", () => {
    render(<NotificationsSettings />);

    const summary = screen.getByText("notificationsDiagnosticsTitle");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  it("gates server event controls when no browser is subscribed", () => {
    hookState.subscribed = false;
    render(<NotificationsSettings />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.queryByText("notificationsDiagnosticsTitle")).toBeNull();
  });
});
