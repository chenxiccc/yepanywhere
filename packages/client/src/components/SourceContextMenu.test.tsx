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
    fireEvent.pointerUp(target);
    fireEvent.click(target);
    expect(onActivate).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(target);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("does not carry long-press suppression past an overlay pointer-up", async () => {
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

    fireEvent.pointerUp(
      screen.getByRole("button", { name: "sourceDismissActions" }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(target);

    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("refreshes only the matching open menu and preserves item focus", () => {
    render(<RefreshMenuHarness />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Target" }));
    const oldItem = screen.getByRole("menuitem", { name: "Old" });
    oldItem.focus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh target" }));

    const newItem = screen.getByRole("menuitem", { name: "New" });
    expect(document.activeElement).toBe(newItem);

    fireEvent.click(
      screen.getByRole("button", { name: "sourceDismissActions" }),
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Other" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh target" }));

    expect(
      screen.getByRole("menuitem", { name: "Other action" }),
    ).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "New" })).toBeNull();
  });
});

function MenuHarness({ onActivate }: { onActivate: () => void }) {
  const controller = useSourceContextMenu(t);
  const actions = [{ label: "Copy", onSelect: vi.fn() }];
  return (
    <>
      <button type="button" {...controller.targetProps(actions, onActivate)}>
        Target
      </button>
      {controller.menu}
    </>
  );
}

function RefreshMenuHarness() {
  const controller = useSourceContextMenu(t);
  return (
    <>
      <button
        type="button"
        {...controller.targetProps(
          [{ label: "Old", onSelect: vi.fn() }],
          vi.fn(),
          { contextKey: "target" },
        )}
      >
        Target
      </button>
      <button
        type="button"
        {...controller.targetProps(
          [{ label: "Other action", onSelect: vi.fn() }],
          vi.fn(),
          { contextKey: "other" },
        )}
      >
        Other
      </button>
      <button
        type="button"
        onClick={() =>
          controller.refreshOpenActions("target", [
            { label: "New", onSelect: vi.fn() },
          ])
        }
      >
        Refresh target
      </button>
      {controller.menu}
    </>
  );
}
