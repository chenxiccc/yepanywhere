import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { FilePathContextMenu } from "../FileResourceActions";

/** Global class names forbidden by this component's CSS Module ownership. */
const REMOVED_LEGACY_CLASSES = [
  "file-path-context-overlay",
  "file-path-context-menu",
];

function renderMenu(props: Partial<
  Parameters<typeof FilePathContextMenu>[0]
> = {}) {
  const onClose = vi.fn();
  const handlers = {
    onCopyContents: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyUrl: vi.fn(),
    onStartNewSession: vi.fn(),
    onView: vi.fn(),
  };
  render(
    <I18nProvider>
      <FilePathContextMenu
        x={10}
        y={10}
        onClose={onClose}
        {...handlers}
        {...props}
      />
    </I18nProvider>,
  );
  return { onClose, ...handlers };
}

function overlay() {
  return screen.getByRole("button", { name: "Dismiss file menu" });
}

describe("FilePathContextMenu", () => {
  afterEach(cleanup);

  it("portals the overlay and menu directly into the body", () => {
    renderMenu();

    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(overlay().parentElement).toBe(document.body);
  });

  it("renders all five items in order when every action is available", () => {
    renderMenu();

    expect(
      screen
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "View",
      "New session",
      "Copy URL",
      "Copy path",
      "Copy contents",
    ]);
  });

  it("omits the conditional items when their actions are unavailable", () => {
    renderMenu({
      canCopyContents: false,
      canStartNewSession: false,
      onCopyUrl: undefined,
    });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["View", "Copy path"]);
  });

  it("omits an item whose handler is missing even when it is enabled", () => {
    renderMenu({ onCopyContents: undefined, onStartNewSession: undefined });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["View", "Copy URL", "Copy path"]);
  });

  it("runs the selected action and then closes", () => {
    // The array records both order and count: exactly one of each, action first.
    const sequence: string[] = [];
    renderMenu({
      onClose: () => sequence.push("close"),
      onCopyPath: () => sequence.push("copyPath"),
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));

    expect(sequence).toEqual(["copyPath", "close"]);
  });

  it("closes on Escape, overlay click, and overlay context menu", () => {
    const { onClose } = renderMenu();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(overlay());
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.contextMenu(overlay());
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("clamps the inline position to the viewport", () => {
    renderMenu({ x: 9999, y: 9999 });

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 190}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 180}px`);
  });

  it("keeps the inline position off the viewport edges", () => {
    renderMenu({ x: -50, y: -50 });

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
  });

  it("styles both portal nodes from the module, not the removed globals", () => {
    renderMenu();

    const menu = screen.getByRole("menu");
    const dismiss = overlay();
    expect(menu.className).toBeTruthy();
    expect(dismiss.className).toBeTruthy();
    expect(menu.className).not.toBe(dismiss.className);
    for (const legacy of REMOVED_LEGACY_CLASSES) {
      expect(document.body.innerHTML).not.toContain(legacy);
    }
  });
});
