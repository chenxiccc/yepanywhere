import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingIndicator } from "../ThinkingIndicator";

describe("ThinkingIndicator", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("shares one observer and pauses indicators outside the viewport", () => {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    const observe = vi.fn();
    const observerConstructor = vi.fn();

    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerConstructor();
        notifyIntersection = callback;
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const { container } = render(
      <>
        <ThinkingIndicator />
        <ThinkingIndicator variant="pill" />
      </>,
    );
    const indicators = Array.from(
      container.querySelectorAll<HTMLElement>("[style]"),
    );

    expect(observerConstructor).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(indicators).toHaveLength(2);
    const firstIndicator = indicators[0];
    const secondIndicator = indicators[1];
    if (!firstIndicator || !secondIndicator) {
      throw new Error("expected two activity indicators");
    }
    expect(
      indicators.map((indicator) =>
        indicator.style.getPropertyValue("--ya-activity-play"),
      ),
    ).toEqual(["paused", "paused"]);

    act(() => {
      notifyIntersection(
        [
          { target: firstIndicator, isIntersecting: true },
          { target: secondIndicator, isIntersecting: false },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });

    expect(firstIndicator.style.getPropertyValue("--ya-activity-play")).toBe(
      "running",
    );
    expect(secondIndicator.style.getPropertyValue("--ya-activity-play")).toBe(
      "paused",
    );
  });
});
