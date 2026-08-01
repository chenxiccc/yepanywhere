import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingIndicator } from "../ThinkingIndicator";

describe("ThinkingIndicator", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a pulsing dot inside the default variant", () => {
    const { container } = render(<ThinkingIndicator />);
    const root = container.firstElementChild;

    expect(root?.tagName).toBe("SPAN");
    expect(root?.firstElementChild?.tagName).toBe("SPAN");
  });

  it("renders a labeled pill and preserves an additional class", () => {
    const { container } = render(
      <ThinkingIndicator
        variant="pill"
        label="Running"
        className="caller-class"
      />,
    );
    const pill = container.firstElementChild;

    expect(pill?.textContent).toBe("Running");
    expect(pill?.classList.contains("caller-class")).toBe(true);
    expect(pill?.firstElementChild?.tagName).toBe("SPAN");
  });

  it("renders the icon variant with its accessible label and SVG", () => {
    render(<ThinkingIndicator variant="icon" label="Working" />);

    const icon = screen.getByRole("img", { name: "Working" });
    expect(icon.getAttribute("title")).toBe("Working");
    expect(icon.querySelector("svg")).not.toBeNull();
  });
});
