// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastContext } from "../../contexts/ToastContext";
import { ToastContainer } from "../Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ErrorToastTrigger() {
  const { showToast } = useToastContext();
  return (
    <button type="button" onClick={() => showToast("Readable error", "error")}>
      Show error
    </button>
  );
}

describe("ToastContainer", () => {
  it("maps every finite toast type to a declared module class", () => {
    render(
      <ToastContainer
        toasts={[
          { id: "error", message: "Error", type: "error" },
          { id: "success", message: "Success", type: "success" },
          { id: "info", message: "Info", type: "info" },
        ]}
        onDismiss={vi.fn()}
      />,
    );

    const toneClasses = screen.getAllByRole("alert").map((toast) => {
      const classes = Array.from(toast.classList);
      expect(classes).toHaveLength(2);
      expect(classes).not.toContain("undefined");
      return classes[1];
    });
    expect(new Set(toneClasses).size).toBe(3);
  });

  it("uses the readable error lifetime and shorter ordinary lifetimes", () => {
    render(
      <ToastContainer
        toasts={[
          { id: "error", message: "Error", type: "error" },
          {
            id: "action",
            message: "Action",
            type: "success",
            action: { label: "Undo", onClick: vi.fn() },
          },
          { id: "info", message: "Info", type: "info" },
        ]}
        onDismiss={vi.fn()}
      />,
    );

    const durations = screen
      .getAllByRole("alert")
      .map((toast) => toast.style.getPropertyValue("--toast-fade-duration"));
    expect(durations).toEqual(["12s", "7s", "4.5s"]);
  });

  it("keeps an error mounted for twelve seconds unless dismissed", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ErrorToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    expect(screen.getByRole("alert").textContent).toContain("Readable error");

    act(() => vi.advanceTimersByTime(11_999));
    expect(screen.queryByRole("alert")).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
