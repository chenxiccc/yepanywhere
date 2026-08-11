// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n";
import { EnvironmentSettings } from "../EnvironmentSettings";

const { getEnvSettings } = vi.hoisted(() => ({
  getEnvSettings: vi.fn(),
}));

vi.mock("../../../api/client", () => ({
  api: { getEnvSettings },
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

describe("EnvironmentSettings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows set variables first and can reveal the full registry", async () => {
    getEnvSettings.mockResolvedValue({
      entries: [
        {
          name: "PORT",
          group: "Server & network",
          description: "Base port.",
          secret: false,
          set: true,
          value: "3400",
        },
        {
          name: "HOST",
          group: "Server & network",
          description: "Extra bind interface.",
          secret: false,
          set: false,
        },
      ],
    });

    render(
      <I18nProvider>
        <EnvironmentSettings />
      </I18nProvider>,
    );

    expect(await screen.findByText("PORT")).toBeTruthy();
    expect(screen.queryByText("HOST")).toBeNull();
    expect(
      screen.getByRole("option", { name: "Set variables only (1)" }),
    ).toHaveProperty("selected", true);

    fireEvent.change(screen.getByLabelText("Show"), {
      target: { value: "all" },
    });

    expect(screen.getByText("HOST")).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "All documented variables (2)" }),
    ).toHaveProperty("selected", true);
  });
});
