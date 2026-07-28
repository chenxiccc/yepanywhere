import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
} from "react";

const SOURCE_LIST_ITEM_SELECTOR =
  "button[data-source-list-item]:not(:disabled)";

/**
 * Keep arrow traversal attached to the list that owns the rows. Enter remains
 * the button's native activation path, so keyboard and pointer open the same
 * detail transition.
 */
export function handleSourceListKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      SOURCE_LIST_ITEM_SELECTOR,
    ),
  );
  if (items.length === 0) return;

  const focused = document.activeElement;
  const currentIndex = items.indexOf(focused as HTMLButtonElement);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex =
    currentIndex < 0
      ? direction > 0
        ? 0
        : items.length - 1
      : Math.min(items.length - 1, Math.max(0, currentIndex + direction));
  const next = items[nextIndex];
  if (!next) return;

  event.preventDefault();
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
