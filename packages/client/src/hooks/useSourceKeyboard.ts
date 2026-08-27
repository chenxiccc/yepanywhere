import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
} from "react";
import { suppressTooltipsFor } from "./useTooltipAppearance";

const SOURCE_LIST_ITEM_SELECTOR = "[data-source-list-item]:not(:disabled)";
const SOURCE_FILE_ITEM_SELECTOR = "[data-source-file-item]:not(:disabled)";
const SOURCE_KEYBOARD_TOOLTIP_SUPPRESSION_MS = 100;

export type SourcePageDirection = -1 | 1;

interface SourceListKeyboardOptions {
  onPage?: (direction: SourcePageDirection) => void;
  filesOnly?: boolean;
}

export function suppressSourceKeyboardTooltips(): void {
  suppressTooltipsFor(SOURCE_KEYBOARD_TOOLTIP_SUPPRESSION_MS);
}

/**
 * Keep arrow traversal attached to the outline that owns the rows.
 */
export function handleSourceListKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  { filesOnly = false, onPage }: SourceListKeyboardOptions = {},
): void {
  const pageDirection =
    event.key === "PageDown" ? 1 : event.key === "PageUp" ? -1 : null;
  if (
    pageDirection === null &&
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight"
  ) {
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  if (pageDirection !== null) {
    if (!onPage) return;
    event.preventDefault();
    suppressSourceKeyboardTooltips();
    onPage(pageDirection);
    return;
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      filesOnly ? SOURCE_FILE_ITEM_SELECTOR : SOURCE_LIST_ITEM_SELECTOR,
    ),
  );
  if (items.length === 0) return;

  const focused = document.activeElement;
  const currentIndex = items.indexOf(focused as HTMLElement);
  if (currentIndex < 0) return;

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const current = items[currentIndex]!;
    const expanded = current.getAttribute("aria-expanded");
    event.preventDefault();
    suppressSourceKeyboardTooltips();
    if (event.key === "ArrowRight") {
      if (expanded === "false") {
        current.click();
        return;
      }
      if (expanded === "true") {
        const firstChild = items[currentIndex + 1];
        if (!firstChild || !current.parentElement?.contains(firstChild)) return;
        firstChild.focus();
      }
      return;
    }
    if (expanded === "true") {
      current.click();
      return;
    }
    const parentList = current.closest("ul");
    if (!parentList || parentList === event.currentTarget) return;
    const parentGroup = parentList.parentElement?.querySelector<HTMLElement>(
      ":scope > [data-source-list-item]:not(:disabled)",
    );
    if (!parentGroup) return;
    parentGroup.focus();
    return;
  }

  const arrowDirection = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex = Math.min(
    items.length - 1,
    Math.max(0, currentIndex + arrowDirection),
  );
  const next = items[nextIndex];
  if (!next) return;

  event.preventDefault();
  suppressSourceKeyboardTooltips();
  if (next === focused) return;
  next.focus();
}

/** Focus the mounted source-browser search with the web-safe `/` shortcut. */
export function useSourceSearchShortcut(
  inputRef: RefObject<HTMLInputElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "/" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target)
      ) {
        return;
      }
      const input = inputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, inputRef]);
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}
