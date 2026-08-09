// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsUndoButton } from "../SettingsUndoButton";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === "settingsUndoSnapshotTooltip"
        ? `Undo changes on ${values?.page} since opening it (${values?.shortcut})`
        : key,
  }),
}));

afterEach(() => cleanup());

function renderUndoButton(undo = vi.fn()) {
  render(
    <SettingsUndoButton
      registration={{ canUndo: true, undo }}
      paneTitle="STT Backends"
    />,
  );
  return undo;
}

describe("SettingsUndoButton", () => {
  it("names the pane rollback and shortcut on the clickable button", () => {
    const undo = renderUndoButton();

    const button = screen.getByRole("button", {
      name: "Undo changes on STT Backends since opening it (Ctrl+Z / ⌘Z)",
    });
    expect(button.title).toBe(
      "Undo changes on STT Backends since opening it (Ctrl+Z / ⌘Z)",
    );

    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("rolls back with Ctrl+Z or Command+Z outside text editing", () => {
    const undo = renderUndoButton();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Z", metaKey: true });

    expect(undo).toHaveBeenCalledTimes(2);
  });

  it("leaves native text undo alone but handles non-text settings controls", () => {
    const undo = vi.fn();
    render(
      <>
        <SettingsUndoButton
          registration={{ canUndo: true, undo }}
          paneTitle="STT Backends"
        />
        <input aria-label="API key" type="password" />
        <input aria-label="Voice input" type="checkbox" />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText("API key"), {
      key: "z",
      ctrlKey: true,
    });
    expect(undo).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("Voice input"), {
      key: "z",
      ctrlKey: true,
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
