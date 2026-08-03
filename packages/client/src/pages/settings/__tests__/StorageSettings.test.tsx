// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { StorageSettings } from "../StorageSettings";

const { state, updateSettings } = vi.hoisted(() => ({
  state: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      projectDirectoryStorage: "app-data",
      toolResultMediaPreservation: "on-demand",
    } as ServerSettings,
    capabilities: [
      "project-directory-storage-policy",
      "tool-result-media-preservation-policy",
    ] as string[],
  },
  updateSettings: vi.fn(),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: state.settings,
    isLoading: false,
    error: null,
    updateSettings,
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({ version: { capabilities: state.capabilities } }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("StorageSettings", () => {
  beforeEach(() => {
    state.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      projectDirectoryStorage: "app-data",
      toolResultMediaPreservation: "on-demand",
    };
    state.capabilities = [
      PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
      TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
    ];
    updateSettings.mockReset();
    updateSettings.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("shows the non-project, on-demand defaults and saves explicit opt-ins", () => {
    render(<StorageSettings />);

    expect(
      (screen.getByLabelText("projectDataLocationAppData") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText("toolResultImagesOnDemand") as HTMLInputElement)
        .checked,
    ).toBe(true);

    fireEvent.click(screen.getByLabelText("projectDataLocationProject"));
    fireEvent.click(screen.getByLabelText("toolResultImagesPreserve"));

    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      projectDirectoryStorage: "project",
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      toolResultMediaPreservation: "preserve",
    });
  });

  it("keeps both controls read-only and warns against an older server", () => {
    state.capabilities = [];
    render(<StorageSettings />);

    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    expect(
      screen.getByText("projectDataLocationUpdateRequired"),
    ).toBeTruthy();
    expect(screen.getByText("toolResultImagesUpdateRequired")).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
