// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeSelector } from "../ModeSelector";

const translations: Record<string, string> = {
  modeAcceptEditsLabel: "Edit",
  modeAutoLabel: "Auto",
  modeBypassPermissionsLabel: "Bypass",
  modeClickToSelect: "Click to select mode",
  modeDefaultLabel: "Ask",
  modeNextTurnHint: "Applies to the next user turn",
  modePendingSuffix: "(pending)",
  modePlanLabel: "Plan",
  modeSelectLabel: "Select mode",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("ModeSelector", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the busy selector compact and explains timing when opened", () => {
    render(
      <ModeSelector mode="plan" onModeChange={vi.fn()} changesApplyNextTurn />,
    );

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.queryByText("Next turn")).toBeNull();
    expect(screen.queryByText("Applies to the next user turn")).toBeNull();
    expect(
      screen.getByTitle("Click to select mode - Applies to the next user turn"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));

    expect(screen.getByText("Applies to the next user turn")).toBeTruthy();
  });

  it("keeps the normal compact selector when changes are immediate", () => {
    render(<ModeSelector mode="default" onModeChange={vi.fn()} />);

    expect(screen.getByText("Ask")).toBeTruthy();
    expect(screen.queryByText("Next turn")).toBeNull();
    expect(screen.getByTitle("Click to select mode")).toBeTruthy();
  });

  it("marks only a selected mode that is still pending", () => {
    render(
      <ModeSelector
        mode="bypassPermissions"
        onModeChange={vi.fn()}
        modeChangePending
      />,
    );

    expect(screen.getByText("Bypass (pending)")).toBeTruthy();
    expect(
      screen.getByTitle("Click to select mode - Applies to the next user turn"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Bypass \(pending\)/ }));
    expect(screen.getByText("Applies to the next user turn")).toBeTruthy();
  });

  it("renders supplied auto mode choices", () => {
    const onModeChange = vi.fn();
    render(
      <ModeSelector
        mode="default"
        onModeChange={onModeChange}
        modes={["default", "auto"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));

    expect(onModeChange).toHaveBeenCalledWith("auto");
  });
});
