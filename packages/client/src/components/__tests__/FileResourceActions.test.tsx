import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import {
  FilePathContextMenu,
  ResourceContextMenu,
} from "../FileResourceActions";

/** Global class names forbidden by this component's CSS Module ownership. */
const REMOVED_LEGACY_CLASSES = [
  "file-path-context-overlay",
  "file-path-context-menu",
];

function renderMenu(
  props: Partial<Parameters<typeof FilePathContextMenu>[0]> = {},
) {
  const onClose = vi.fn();
  const handlers = {
    onCopyAbsolutePath: vi.fn(),
    onCopyContents: vi.fn(),
    onCopyProjectRelativePath: vi.fn(),
    onCopyViewerLink: vi.fn(),
    onOpen: vi.fn(),
    onOpenPreview: vi.fn(),
    onOpenSource: vi.fn(),
    onStartNewSession: vi.fn(),
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
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("portals the overlay and menu directly into the body", () => {
    renderMenu();

    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(overlay().parentElement).toBe(document.body);
  });

  it("groups open and copy actions in touch-selectable panels", () => {
    renderMenu();

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open›", "New session", "Copy›"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["‹Back", "Source", "Preview"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "‹Back",
      "Project-relative path",
      "Absolute file path",
      "Viewer link",
      "Contents",
    ]);
  });

  it("adds capability-shaped image actions without file-only entries", () => {
    const onCopyImage = vi.fn();
    const onDownload = vi.fn();
    render(
      <I18nProvider>
        <ResourceContextMenu
          x={10}
          y={10}
          canStartNewSession={false}
          dismissLabel="Dismiss image actions"
          onClose={vi.fn()}
          onCopyImage={onCopyImage}
          onDownload={onDownload}
          onOpen={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Download", "Copy›"]);
    expect(
      screen.getByRole("button", { name: "Dismiss image actions" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["‹Back", "Image"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Image" }));
    expect(onCopyImage).toHaveBeenCalledTimes(1);
  });

  it("opens adjacent submenus on hover-capable pointers", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    renderMenu();

    const rootMenu = screen.getByRole("menu");
    const openItem = within(rootMenu).getByRole("menuitem", { name: "Open" });
    fireEvent.mouseEnter(openItem);

    expect(document.body.contains(rootMenu)).toBe(true);
    expect(openItem.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("menu", { name: "Open" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Source", "Preview"]);
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();

    fireEvent.mouseEnter(
      within(rootMenu).getByRole("menuitem", { name: "Copy" }),
    );
    expect(screen.queryByRole("menu", { name: "Open" })).toBeNull();
    expect(
      within(screen.getByRole("menu", { name: "Copy" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Project-relative path",
      "Absolute file path",
      "Viewer link",
      "Contents",
    ]);

    fireEvent.mouseEnter(
      within(rootMenu).getByRole("menuitem", { name: "New session" }),
    );
    expect(screen.queryByRole("menu", { name: "Copy" })).toBeNull();

    fireEvent.click(within(rootMenu).getByRole("menuitem", { name: "Copy" }));
    expect(
      document.body.contains(screen.getByRole("menu", { name: "Copy" })),
    ).toBe(true);
  });

  it("omits the conditional items when their actions are unavailable", () => {
    renderMenu({
      canStartNewSession: false,
      onCopyAbsolutePath: undefined,
      onCopyContents: undefined,
      onCopyProjectRelativePath: undefined,
      onCopyViewerLink: undefined,
      onOpenPreview: undefined,
      onOpenSource: undefined,
    });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open"]);
  });

  it("uses an unclassified file-path label when no stronger path is known", () => {
    renderMenu({
      onCopyAbsolutePath: undefined,
      onCopyContents: undefined,
      onCopyFilePath: vi.fn(),
      onCopyProjectRelativePath: undefined,
      onCopyViewerLink: undefined,
      onStartNewSession: undefined,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["‹Back", "File path"]);
  });

  it("runs the selected action and then closes", () => {
    // The array records both order and count: exactly one of each, action first.
    const sequence: string[] = [];
    renderMenu({
      onClose: () => sequence.push("close"),
      onCopyProjectRelativePath: () => sequence.push("copyPath"),
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Project-relative path" }),
    );

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
    expect(menu.style.left).toBe(`${window.innerWidth - 230}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 180}px`);
  });

  it("keeps the inline position off the viewport edges", () => {
    renderMenu({ x: -50, y: -50 });

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
  });

  it("opens a hover flyout to the left when the right edge is constrained", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    renderMenu({ x: 9999, y: 10 });

    const rootMenu = screen.getByRole("menu");
    fireEvent.mouseEnter(
      within(rootMenu).getByRole("menuitem", { name: "Open" }),
    );

    expect(screen.getByRole("menu", { name: "Open" }).style.left).toBe(
      `${window.innerWidth - 448}px`,
    );
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
