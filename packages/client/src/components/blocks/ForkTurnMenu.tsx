import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import styles from "./ForkTurnMenu.module.css";

interface ForkTurnMenuProps {
  onForkBefore?: () => void;
  onForkAfter: () => void;
  onForkAfterSummary: () => void;
  afterDisabled?: boolean;
}

export function ForkTurnMenu({
  onForkBefore,
  onForkAfter,
  onForkAfterSummary,
  afterDisabled = false,
}: ForkTurnMenuProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuHeight = onForkBefore ? 132 : 92;
      const top =
        rect.bottom + 8 + menuHeight <= window.innerHeight
          ? rect.bottom + 8
          : Math.max(8, rect.top - menuHeight - 8);
      setPosition({
        top,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setIsOpen(true);
  };

  const run = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  const menu = (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      style={
        {
          "--fork-turn-menu-top": `${position.top}px`,
          "--fork-turn-menu-right": `${position.right}px`,
        } as CSSProperties
      }
      aria-label={t("forkTurnMenuLabel")}
    >
      {onForkBefore && (
        <button type="button" role="menuitem" onClick={() => run(onForkBefore)}>
          {t("forkTurnBefore")}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        disabled={afterDisabled}
        title={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
        onClick={() => run(onForkAfter)}
      >
        {t("forkTurnAfter")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.secondary}
        disabled={afterDisabled}
        title={afterDisabled ? t("forkTurnAfterDisabled") : undefined}
        onClick={() => run(onForkAfterSummary)}
      >
        {t("forkTurnAfterSummary")}
      </button>
    </div>
  );

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        className="user-prompt-action"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        aria-label={t("forkTurnMenuLabel")}
        title={t("forkTurnMenuLabel")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="12" r="3" />
          <path d="M6 9v6" />
          <path d="M8.5 7.5 15 11" />
        </svg>
      </button>
      {isOpen && createPortal(menu, document.body)}
    </div>
  );
}
