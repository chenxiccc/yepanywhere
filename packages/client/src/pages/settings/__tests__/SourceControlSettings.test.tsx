// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { SourceControlSettings } from "../SourceControlSettings";

const { state, updateSettings } = vi.hoisted(() => ({
  state: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      sourceReviewSubmissionsEnabled: false,
      sourceReviewResponseTurns: 8,
    } as ServerSettings,
    capabilities: ["git-source-review-submissions"] as string[],
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

describe("SourceControlSettings", () => {
  beforeEach(() => {
    state.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      sourceReviewSubmissionsEnabled: false,
      sourceReviewResponseTurns: 8,
    };
    state.capabilities = [GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY];
    updateSettings.mockReset();
    updateSettings.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("keeps submissions default-off and saves an explicit opt-in", () => {
    render(<SourceControlSettings />);
    const toggle = screen.getByRole("checkbox", {
      name: "sourceReviewSubmissionsSettingTitle",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({
      sourceReviewSubmissionsEnabled: true,
    });
  });

  it("saves a valid response-turn bound and rejects an invalid draft", () => {
    render(<SourceControlSettings />);
    const input = screen.getByRole("spinbutton", {
      name: "sourceReviewResponseTurnsSettingTitle",
    });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(updateSettings).toHaveBeenCalledWith({
      sourceReviewResponseTurns: 12,
    });

    updateSettings.mockClear();
    fireEvent.change(input, { target: { value: "33" } });
    fireEvent.blur(input);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("renders nothing without the permanent capability", () => {
    state.capabilities = [];
    const { container } = render(<SourceControlSettings />);
    expect(container.textContent).toBe("");
  });
});
