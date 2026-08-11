// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDeveloperModeForTest,
  getRelayDebugEnabled,
} from "../../../hooks/useDeveloperMode";
import { UI_KEYS } from "../../../lib/storageKeys";
import { DevelopmentSettings } from "../DevelopmentSettings";

let isManualReloadMode = true;
let interruptibleSessionCount = 0;
let queuedSessionMessageCount = 0;

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    ignoredTools: [],
    clearIgnoredTools: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useReloadNotifications", () => ({
  useReloadNotifications: () => ({
    isManualReloadMode,
    pendingReloads: { backend: false },
    connected: true,
    reloadBackend: vi.fn(),
    unsafeToRestart:
      interruptibleSessionCount > 0 || queuedSessionMessageCount > 0,
    interruptibleSessionCount,
    queuedSessionMessageCount,
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
    t: (key: string, params?: Record<string, string | number>) =>
      (
        ({
          developmentSectionTitle: "Development",
          developmentSchemaTitle: "Schema Validation",
          developmentSchemaDescription: "Validate tool results",
          developmentCrossHostDelegationTitle: "YA Hosts Preview",
          developmentCrossHostDelegationDescription:
            "Expose the experimental host preview",
          developmentHostsPreviewOpen: "Open YA Hosts",
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
          developmentInterruptedWarning:
            "{count} active session{suffix}will be interrupted",
          developmentInterruptedWarningActiveAndQueued:
            "{activeCount} active session{activeSuffix} and {queuedCount} queued message{queuedSuffix} will be interrupted",
          developmentInterruptedWarningQueued:
            "{count} queued message{suffix} will be interrupted",
          developmentRestart: "Restart Server",
        }) as Record<string, string>
      )[key]?.replaceAll(/\{(\w+)\}/gu, (_match, name: string) =>
        String(params?.[name] ?? ""),
      ) ?? key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("DevelopmentSettings", () => {
  const renderSettings = () =>
    render(
      <MemoryRouter>
        <DevelopmentSettings />
      </MemoryRouter>,
    );

  beforeEach(() => {
    isManualReloadMode = true;
    interruptibleSessionCount = 0;
    queuedSessionMessageCount = 0;
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  it("shows the remaining development settings", () => {
    renderSettings();

    expect(screen.getByText("Schema Validation")).toBeTruthy();
    expect(screen.getByText("YA Hosts Preview")).toBeTruthy();
    expect(screen.getByText("All Hosts Monitor")).toBeTruthy();
    expect(screen.getByText("Relay Debug Logging")).toBeTruthy();
    expect(screen.getByText("Browser Diagnostics")).toBeTruthy();
    expect(screen.getByText("Service Worker")).toBeTruthy();
    expect(screen.getByText("Workstreams")).toBeTruthy();
    expect(screen.getByText("Session Scroll Memory")).toBeTruthy();
    expect(screen.queryByText("Store-Backed Session Detail")).toBeNull();
  });

  it("keeps development settings visible when server restart is unavailable", () => {
    isManualReloadMode = false;

    renderSettings();

    expect(screen.getByText("Schema Validation")).toBeTruthy();
    expect(screen.getByText("Browser Diagnostics")).toBeTruthy();
    expect(screen.queryByText("Restart Server")).toBeNull();
  });

  it("warns about the work the restart would actually interrupt", () => {
    interruptibleSessionCount = 1;
    queuedSessionMessageCount = 2;

    renderSettings();

    expect(
      screen.getByText(
        "1 active session and 2 queued messages will be interrupted",
      ),
    ).toBeTruthy();
  });

  it("exposes the session cursor behavior debug setting", () => {
    renderSettings();

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
    renderSettings();

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
    renderSettings();

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

  it("reveals the server-scoped hosts route behind its toggle", () => {
    renderSettings();

    expect(screen.queryByRole("link", { name: "Open YA Hosts" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "YA Hosts Preview" }));

    const previewRow = screen
      .getByText("YA Hosts Preview")
      .closest("[data-settings-item]");
    expect(previewRow).not.toBeNull();
    const link = within(previewRow as HTMLElement).getByRole("link", {
      name: "Open YA Hosts",
    });
    expect(link.getAttribute("href")).toBe("/-/hosts");
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      crossHostDelegationEnabled: true,
    });
  });
});
