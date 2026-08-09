// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProjectSessionDefaultsModal } from "../ProjectSessionDefaultsModal";

const { mockGetDefaults, mockUpdateDefaults } = vi.hoisted(() => ({
  mockGetDefaults: vi.fn(),
  mockUpdateDefaults: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProjectSessionDefaults: mockGetDefaults,
    updateProjectSessionDefaults: mockUpdateDefaults,
  },
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      heartbeatTurnsAfterMinutes: 20,
      heartbeatTurnText: "global heartbeat",
    },
  }),
}));

describe("ProjectSessionDefaultsModal", () => {
  beforeEach(() => {
    mockGetDefaults.mockResolvedValue({
      overrides: {
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: null,
      },
      recentHeartbeatTurnTexts: ["check tests", "continue carefully"],
    });
    mockUpdateDefaults.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads inherited defaults and saves independent project overrides", async () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <ProjectSessionDefaultsModal
          projectId="project-1"
          projectName="Alpha"
          onClose={onClose}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(mockGetDefaults).toHaveBeenCalledWith("project-1");
    });

    const minutes = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(minutes.value).toBe("20");
    expect(minutes.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Use global (20m)" }));
    fireEvent.change(minutes, { target: { value: "45" } });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "check tests" },
    });

    const message = screen.getByRole("textbox", {
      name: "Inactivity nudge message",
    }) as HTMLTextAreaElement;
    expect(message.value).toBe("check tests");
    expect(message.maxLength).toBe(2000);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateDefaults).toHaveBeenCalledWith("project-1", {
        heartbeatTurnsAfterMinutes: 45,
        heartbeatTurnText: "check tests",
      });
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("seeds the global message when inheritance is disabled", async () => {
    render(
      <I18nProvider>
        <ProjectSessionDefaultsModal projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    await screen.findByRole("textbox", {
      name: "Inactivity nudge message",
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use global message" }),
    );

    expect(
      (
        screen.getByRole("textbox", {
          name: "Inactivity nudge message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("global heartbeat");
  });
});
