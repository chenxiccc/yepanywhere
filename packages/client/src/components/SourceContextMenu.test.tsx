// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSourceContextMenu } from "./SourceContextMenu";

const t = (key: string) => key;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SourceContextMenu", () => {
  it("opens from touch long-press and consumes its follow-up click", async () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    render(<MenuHarness onActivate={onActivate} />);

    const target = screen.getByRole("button", { name: "Target" });
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 24,
      clientY: 30,
    });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    fireEvent(target, pointerDown);
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(
      screen.getByRole("menu", { name: "sourceActionMenu" }),
    ).toBeDefined();
    fireEvent.click(target);
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(target);
    expect(onActivate).toHaveBeenCalledOnce();
  });
});

function MenuHarness({ onActivate }: { onActivate: () => void }) {
  const controller = useSourceContextMenu(t);
  const actions = [{ label: "Copy", onSelect: vi.fn() }];
  return (
    <>
      <button
        type="button"
        {...controller.targetProps(actions, onActivate)}
      >
        Target
      </button>
      {controller.menu}
    </>
  );
}
