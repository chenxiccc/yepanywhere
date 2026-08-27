// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer } from "../components/ui/TooltipLayer";
import {
  clearTooltipWarmth,
  DEFAULT_TOOLTIP_DELAY_MS,
} from "./useTooltipAppearance";
import { handleSourceListKeyDown } from "./useSourceKeyboard";
import { UI_KEYS } from "../lib/storageKeys";

function SourceFileList({
  filesOnly = true,
  onPage,
}: {
  filesOnly?: boolean;
  onPage?: (direction: -1 | 1) => void;
}) {
  const [selected, setSelected] = useState("first");
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <output data-testid="selected">{selected}</output>
      <ul
        onKeyDown={(event) =>
          handleSourceListKeyDown(event, { filesOnly, onPage })
        }
      >
        <li>
          <button
            type="button"
            data-source-list-item
            title="Directory group"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            Group
          </button>
          {expanded && (
            <ul>
              {[
                ["first", "src/first.ts"],
                ["second", "src/second.ts"],
              ].map(([id, path]) => (
                <li key={id}>
                  <button
                    type="button"
                    data-source-list-item
                    data-source-file-item
                    title={path}
                    onClick={() => setSelected(id!)}
                    onFocus={() => setSelected(id!)}
                  >
                    {id}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </>
  );
}

describe("source-list keyboard navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    clearTooltipWarmth();
  });

  afterEach(() => {
    cleanup();
    clearTooltipWarmth();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves among files after pointer selection without showing tooltips", () => {
    render(
      <>
        <TooltipLayer />
        <SourceFileList />
      </>,
    );
    const first = screen.getByRole("button", { name: "first" });
    const second = screen.getByRole("button", { name: "second" });
    const nativeMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector,
    ) {
      return selector === ":focus-visible"
        ? this === document.activeElement
        : nativeMatches.call(this, selector);
    });

    fireEvent.pointerDown(first, { pointerType: "mouse", button: 0 });
    act(() => first.focus());
    fireEvent.click(first);
    act(() => vi.advanceTimersByTime(DEFAULT_TOOLTIP_DELAY_MS));
    expect(screen.getByRole("tooltip").textContent).toBe("src/first.ts");

    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(document.activeElement).toBe(second);
    expect(screen.getByTestId("selected").textContent).toBe("second");
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    expect(screen.getByTestId("selected").textContent).toBe("first");
  });

  it("pages the diff without moving file focus", () => {
    const onPage = vi.fn();
    render(<SourceFileList onPage={onPage} />);
    const first = screen.getByRole("button", { name: "first" });
    act(() => first.focus());

    fireEvent.keyDown(first, { key: "PageDown" });
    fireEvent.keyDown(first, { key: "PageUp" });

    expect(onPage.mock.calls).toEqual([[1], [-1]]);
    expect(document.activeElement).toBe(first);
  });

  it("uses left and right to traverse and disclose outline groups", () => {
    render(<SourceFileList filesOnly={false} />);
    const group = screen.getByRole("button", { name: "Group" });
    act(() => group.focus());

    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(group.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(group.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowRight" });

    const first = screen.getByRole("button", { name: "first" });
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(group);
  });
});
