import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import styles from "./FilterDropdown.module.css";

// Breakpoint for desktop behavior (should match CSS)
const DESKTOP_BREAKPOINT = 769;

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string; // Optional description shown below label
  meta?: ReactNode; // Optional trailing metadata, e.g. provider quota usage
  count?: number;
  color?: string; // For provider colors (colored dot)
  clearSelection?: false;
  dividerBefore?: boolean;
  groupLabelBefore?: string;
  disabled?: boolean;
}

export interface FilterResetOption {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  meta?: ReactNode;
  count?: number;
  color?: string;
  clearSelection: true; // Option row that resets selected values
  dividerBefore?: boolean;
  groupLabelBefore?: string;
  disabled?: boolean;
}

export type FilterDropdownOption<T extends string> =
  | FilterOption<T>
  | FilterResetOption;

export interface FilterDropdownProps<T extends string> {
  label: string;
  options: FilterDropdownOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  multiSelect?: boolean; // default true
  placeholder?: string; // shown when nothing selected
  placeholderContent?: ReactNode; // overrides placeholder for custom visual summaries
  triggerContent?: ReactNode; // replaces the trigger label entirely (e.g. a badge chip)
  triggerTitle?: string; // title/aria-label override for the trigger button
  align?: "left" | "right"; // dropdown alignment, default left
  /** Stretch the trigger to fill its field, e.g. a settings or form row. */
  fullWidth?: boolean;
  /** "chip" is the borderless trigger used in composer toolbars. */
  triggerVariant?: "default" | "chip";
  /** "model" top-aligns option rows for badge + description layout. */
  panelVariant?: "default" | "model";
  /** Caller-owned class for the trigger button, for caller-specific sizing. */
  triggerClassName?: string;
  /** Caller-owned class for the container and the mobile sheet. */
  className?: string;
}

/**
 * Filter dropdown that opens a bottom sheet (mobile) or dropdown (desktop).
 * Supports multi-select with checkboxes and optional colored dots.
 * Clicking outside the popup or pressing Escape closes it.
 */
export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
  multiSelect = true,
  placeholder,
  placeholderContent,
  triggerContent,
  triggerTitle,
  align = "left",
  fullWidth = false,
  triggerVariant = "default",
  panelVariant = "default",
  triggerClassName,
  className = "",
}: FilterDropdownProps<T>) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen((prev) => !prev);
  };

  const hasClearSelectionOption = options.some(
    (option) => option.clearSelection,
  );

  const handleOptionClick = (option: FilterDropdownOption<T>) => {
    if (option.disabled) return;
    if (option.clearSelection) {
      onChange([]);
      setIsOpen(false);
      return;
    }

    const { value } = option;
    if (multiSelect) {
      if (selected.includes(value)) {
        onChange(selected.filter((v) => v !== value));
      } else {
        onChange([...selected, value]);
      }
    } else {
      // Single-select: toggle off if already selected, otherwise select
      if (selected.includes(value)) {
        onChange([]);
      } else {
        onChange([value]);
      }
      setIsOpen(false);
    }
  };

  const handleClearAll = () => {
    onChange([]);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen || !isDesktop) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        sheetRef.current &&
        !sheetRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, isDesktop, handleClose]);

  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  const displayContent = (() => {
    if (selected.length === 0) {
      return placeholderContent ?? placeholder ?? label;
    }
    if (selected.length === 1) {
      const selectedOption = options.find((o) => o.value === selected[0]);
      return selectedOption?.label || label;
    }
    return `${label} (${selected.length})`;
  })();

  const isModelPanel = panelVariant === "model";

  const optionsContent = (
    <>
      {multiSelect && selected.length > 0 && !hasClearSelectionOption && (
        <>
          <button
            type="button"
            className={cx(styles.option, styles.clear)}
            onClick={handleClearAll}
          >
            <span className={styles.label}>{t("filterClearAll")}</span>
          </button>
          <div className={styles.divider} />
        </>
      )}

      {options.map((option) => {
        const isSelected = option.clearSelection
          ? selected.length === 0
          : selected.includes(option.value);
        const showCheckbox = multiSelect && !option.clearSelection;
        return (
          <Fragment key={option.value}>
            {(option.dividerBefore || option.groupLabelBefore) && (
              <div className={styles.divider} />
            )}
            {option.groupLabelBefore && (
              <div className={styles.groupLabel}>{option.groupLabelBefore}</div>
            )}
            <button
              type="button"
              className={cx(
                styles.option,
                isSelected && styles.selected,
                !multiSelect && styles.singleSelect,
                isModelPanel && styles.model,
              )}
              onClick={() => handleOptionClick(option)}
              disabled={option.disabled}
              aria-pressed={isSelected}
            >
              {showCheckbox && (
                <span
                  className={cx(styles.checkbox, isSelected && styles.checked)}
                  aria-hidden="true"
                >
                  {isSelected && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
              )}
              {multiSelect && option.clearSelection && (
                <span className={styles.checkboxSpacer} aria-hidden="true" />
              )}

              {option.color && (
                <span
                  className={styles.colorDot}
                  style={{ backgroundColor: option.color }}
                  aria-hidden="true"
                />
              )}

              {option.icon && (
                <span
                  className={cx(styles.optionIcon, isModelPanel && styles.model)}
                  aria-hidden="true"
                >
                  {option.icon}
                </span>
              )}

              <span className={styles.labelWrapper}>
                <span className={styles.label}>{option.label}</span>
                {option.description && (
                  <span className={styles.description}>
                    {option.description}
                  </span>
                )}
              </span>

              {option.meta && <span className={styles.meta}>{option.meta}</span>}

              {option.count !== undefined && (
                <span className={styles.count}>{option.count}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </>
  );

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the sheet; Escape is handled globally
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className={styles.overlay}
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className={cx(styles.sheet, className)}
              role="dialog"
              tabIndex={-1}
              aria-label={t("filterByLabel", { label })}
            >
              <div className={styles.header}>
                <span className={styles.title}>{label}</span>
              </div>
              <div className={styles.options}>{optionsContent}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className={cx(
          styles.dropdown,
          align === "right" && styles.alignRight,
          isModelPanel && styles.model,
        )}
        role="dialog"
        tabIndex={-1}
        aria-label={t("filterByLabel", { label })}
      >
        <div className={styles.options}>{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div
      className={cx(styles.container, fullWidth && styles.fullWidth, className)}
    >
      <button
        ref={buttonRef}
        type="button"
        className={cx(
          styles.button,
          selected.length > 0 && styles.hasSelection,
          fullWidth && styles.fullWidth,
          triggerVariant === "chip" && styles.chip,
          triggerClassName,
        )}
        onClick={handleButtonClick}
        title={triggerTitle ?? t("filterByLabel", { label })}
        aria-label={triggerTitle ?? t("filterByLabel", { label })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={styles.buttonLabel}>
          {triggerContent ?? displayContent}
        </span>
        <svg
          className={styles.chevron}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
