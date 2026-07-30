// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDeveloperModeForTest,
  getRelayDebugEnabled,
} from "../../../hooks/useDeveloperMode";
import { UI_KEYS } from "../../../lib/storageKeys";
import { DevelopmentSettings } from "../DevelopmentSettings";

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    ignoredTools: [],
    clearIgnoredTools: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useReloadNotifications", () => ({
  useReloadNotifications: () => ({
    isManualReloadMode: true,
    pendingReloads: { backend: false },
    connected: true,
    reloadBackend: vi.fn(),
    unsafeToRestart: false,
    interruptibleSessionCount: 0,
  }),
}));

vi.mock("../../../hooks/useSchemaValidation", () => ({
  useSchemaValidation: () => ({
    settings: { enabled: false },
    setEnabled: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { serviceWorkerEnabled: true, workstreamsEnabled: false },
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        ({
          developmentSectionTitle: "Development",
          developmentSchemaTitle: "Schema Validation",
          developmentSchemaDescription: "Validate tool results",
          developmentMultiHostMonitorTitle: "All Hosts Monitor",
          developmentMultiHostMonitorDescription:
            "Show the experimental all-hosts monitor link",
          developmentRelayDebugTitle: "Relay Debug Logging",
          developmentRelayDebugDescription: "Capture relay traffic",
          developmentDiagnosticsTitle: "Browser Diagnostics",
          developmentDiagnosticsDescription: "Capture browser logs",
          developmentServiceWorkerTitle: "Service Worker",
          developmentServiceWorkerDescription: "Enable service worker",
          developmentWorkstreamsTitle: "Workstreams",
          developmentWorkstreamsDescription:
            "Enable experimental workstream surfaces and APIs",
          developmentSessionScrollMemoryTitle: "Session Scroll Memory",
          developmentSessionScrollMemoryControlTitle: "Restore mode",
          developmentSessionScrollMemoryDescription: "Debug restore mode",
          developmentSessionScrollMemoryModeLiveTail: "Live tail (default)",
          developmentSessionScrollMemoryModeLiveTailDescription:
            "Reopen at latest output",
          developmentSessionScrollMemoryModeRememberPlace: "Remember place",
          developmentSessionScrollMemoryModeRememberPlaceDescription:
            "Reopen at last viewed row",
          developmentSessionScrollMemoryModeManualFollow: "Manual follow",
          developmentSessionScrollMemoryModeManualFollowDescription:
            "Manual follow experiment",
          developmentSessionScrollMemoryModeNoMemory: "No memory",
          developmentSessionScrollMemoryModeNoMemoryDescription:
            "Do not retain scroll snapshots",
          developmentRestartTitle: "Restart Server",
          developmentRestartDescription: "Restart the backend server",
          developmentRestart: "Restart Server",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("DevelopmentSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  it("shows the remaining development settings", () => {
    render(<DevelopmentSettings />);

    expect(screen.getByText("Schema Validation")).toBeTruthy();
    expect(screen.getByText("All Hosts Monitor")).toBeTruthy();
    expect(screen.getByText("Relay Debug Logging")).toBeTruthy();
    expect(screen.getByText("Browser Diagnostics")).toBeTruthy();
    expect(screen.getByText("Service Worker")).toBeTruthy();
    expect(screen.getByText("Workstreams")).toBeTruthy();
    expect(screen.getByText("Session Scroll Memory")).toBeTruthy();
    expect(screen.queryByText("Store-Backed Session Detail")).toBeNull();
  });

  it("exposes the session cursor behavior debug setting", () => {
    render(<DevelopmentSettings />);

    const select = screen.getByLabelText("Restore mode") as HTMLSelectElement;
    expect(select.value).toBe("live-tail");

    fireEvent.change(select, { target: { value: "remember-place" } });

    expect(select.value).toBe("remember-place");
    expect(localStorage.getItem(UI_KEYS.sessionScrollBehavior)).toBe(
      "remember-place",
    );
    expect(screen.getByText("Reopen at last viewed row")).toBeTruthy();
  });

  it("toggles relay debug logging from development settings", () => {
    render(<DevelopmentSettings />);

    const toggle = screen.getByRole("checkbox", {
      name: "Relay Debug Logging",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(getRelayDebugEnabled()).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(getRelayDebugEnabled()).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      relayDebugEnabled: true,
    });
  });

  it("toggles the all-hosts monitor link from development settings", () => {
    render(<DevelopmentSettings />);

    const toggle = screen.getByRole("checkbox", {
      name: "All Hosts Monitor",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      multiHostMonitorEnabled: true,
    });
  });
});
