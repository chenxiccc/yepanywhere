import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerCountIndicator } from "../ViewerCountIndicator";

const LEGACY_CLASSES = [
  "viewer-count-indicator",
  "viewer-count-indicator-button",
  "viewer-count-indicator-icon",
];

function legacyClassesOn(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) =>
    [...el.classList].filter((name) => LEGACY_CLASSES.includes(name)),
  );
}

describe("ViewerCountIndicator", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the noninteractive status variant with its icon", () => {
    render(<ViewerCountIndicator label="No active viewers" />);

    const status = screen.getByRole("status", { name: "No active viewers" });
    expect(status.tagName).toBe("SPAN");
    expect(status.getAttribute("title")).toBe("No active viewers");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(status.querySelectorAll("svg path")).toHaveLength(4);
  });

  it("omits the count element unless a numeric count is supplied", () => {
    const { rerender } = render(
      <ViewerCountIndicator label="No active viewers" />,
    );
    expect(screen.getByRole("status").querySelector("span")).toBeNull();

    rerender(<ViewerCountIndicator count={0} label="No active viewers" />);
    expect(screen.getByRole("status").querySelector("span")?.textContent).toBe(
      "0",
    );

    rerender(<ViewerCountIndicator count={7} label="7 active viewers" />);
    expect(screen.getByRole("status").querySelector("span")?.textContent).toBe(
      "7",
    );
  });

  it("renders the interactive button variant and delivers clicks", () => {
    const onClick = vi.fn();
    render(
      <ViewerCountIndicator
        count={3}
        label="3 active viewers"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole("button", { name: "3 active viewers" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("3 active viewers");
    expect(button.querySelector("span")?.textContent).toBe("3");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ target: button }),
    );
  });

  it("preserves a caller-supplied class on both variants", () => {
    const { container, rerender } = render(
      <ViewerCountIndicator
        label="No active viewers"
        className="caller-class"
      />,
    );
    const status = screen.getByRole("status");
    expect(status.classList.contains("caller-class")).toBe(true);
    // The caller class is additive: the component keeps its own root class too.
    expect(status.classList.length).toBeGreaterThan(1);
    expect(container.firstElementChild).toBe(status);

    rerender(
      <ViewerCountIndicator
        label="3 active viewers"
        className="caller-class"
        onClick={() => {}}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.classList.contains("caller-class")).toBe(true);
    expect(button.classList.length).toBeGreaterThan(2);
  });

  it("no longer emits the legacy global class vocabulary", () => {
    const { container, rerender } = render(
      <ViewerCountIndicator count={3} label="3 active viewers" />,
    );
    expect(legacyClassesOn(container)).toEqual([]);

    rerender(
      <ViewerCountIndicator
        count={3}
        label="3 active viewers"
        onClick={() => {}}
      />,
    );
    expect(legacyClassesOn(container)).toEqual([]);
  });
});
