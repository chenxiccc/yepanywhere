// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "../Toast";

afterEach(cleanup);

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
});
