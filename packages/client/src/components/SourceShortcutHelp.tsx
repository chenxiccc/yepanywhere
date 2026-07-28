import { useEffect, useRef, useState } from "react";
import type { TranslationFn } from "../i18n";

/** Compact hover/focus/tap disclosure for Source Control keyboard shortcuts. */
export function SourceShortcutHelp({ t }: { t: TranslationFn }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const open = hovered || focused || pinned;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setHovered(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setHovered(false);
        setFocused(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const shortcuts = [
    ["/", t("sourceShortcutSearch")],
    ["↑ ↓", t("sourceShortcutNavigate")],
    ["Enter", t("sourceShortcutOpen")],
    ["Esc", t("sourceShortcutBack")],
    ["N P", t("sourceShortcutHunks")],
    ["⇧ F10", t("sourceShortcutActions")],
  ] as const;

  return (
    <span
      ref={rootRef}
      className="source-shortcut-help"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <button
        type="button"
        className="source-shortcut-help-trigger"
        aria-label={t("sourceShortcutHelp")}
        aria-expanded={open}
        onClick={(event) => {
          if (pinned) {
            setPinned(false);
            setHovered(false);
            setFocused(false);
            event.currentTarget.blur();
          } else {
            setPinned(true);
          }
        }}
      >
        ?
      </button>
      {open && (
        <span className="source-shortcut-popover" role="tooltip">
          <span className="source-shortcut-popover-title">
            {t("sourceShortcutHelp")}
          </span>
          {shortcuts.map(([keys, label]) => (
            <span key={keys} className="source-shortcut-row">
              <kbd>{keys}</kbd>
              <span>{label}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
