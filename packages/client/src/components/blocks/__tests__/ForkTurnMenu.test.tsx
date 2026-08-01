// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkTurnMenu } from "../ForkTurnMenu";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ForkTurnMenu", () => {
  it("passes measured desktop position through overridable CSS variables", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 20,
      left: 880,
      right: 900,
      top: 80,
      width: 20,
      x: 880,
      y: 80,
      toJSON: () => ({}),
    });

    render(<ForkTurnMenu onForkAfter={vi.fn()} onForkAfterSummary={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "forkTurnMenuLabel" }));

    const menu = screen.getByRole("menu");
    expect(menu.style.getPropertyValue("--fork-turn-menu-top")).toBe("108px");
    expect(menu.style.getPropertyValue("--fork-turn-menu-right")).toBe("100px");
    expect(menu.style.top).toBe("");
    expect(menu.style.right).toBe("");
  });
});
