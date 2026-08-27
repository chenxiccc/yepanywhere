import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../../lib/markdownSelectionCopy";

const ANCHORED_MODAL_MARGIN_PX = 8;
const ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX = 600;
let modalHistoryEntrySequence = 0;
let modalBackspaceOwnerSequence = 0;
let modalLayerOwnerSequence = 0;
const modalBackspaceOwners: Array<{
  id: number;
  close: () => void;
}> = [];
const modalLayerOwners: Array<{
  id: number;
  close: () => void;
}> = [];
let bodyScrollOwners = 0;
let bodyOverflowBeforeModal: string | null = null;

export interface ModalAnchorRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface ModalProps {
  title: ReactNode;
  actions?: ReactNode;
  headerActionsClassName?: string;
  headerClassName?: string;
  children: ReactNode;
  onClose: () => void;
  onMinimize?: () => void;
  minimized?: boolean;
  anchorRect?: ModalAnchorRect | null;
  anchorAtAnyWidth?: boolean;
  variant?: "image-viewer";
  contentRef?: RefObject<HTMLDivElement | null>;
  /**
   * When true, opening pushes a history entry so a browser "back" — the mobile
   * OS back-swipe — dismisses the modal, keeping history balanced. Used by the
   * mobile-only diff/blame viewers so a back-swipe closes them
   * (topic: source-review-to-session).
   */
  closeOnBackGesture?: boolean;
  /** Close only the topmost opted-in modal when Backspace is not editing text. */
  closeOnBackspace?: boolean;
}

function isEditableBackspaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
    ),
  );
}

function handleModalBackspace(event: KeyboardEvent): void {
  if (
    event.key !== "Backspace" ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableBackspaceTarget(event.target)
  ) {
    return;
  }
  const owner = latestModalOwner(modalBackspaceOwners);
  if (!owner) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  owner.close();
}

function handleModalEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const owner = latestModalOwner(modalLayerOwners);
  if (!owner) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  owner.close();
}

function latestModalOwner<T extends { id: number }>(
  owners: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const owner of owners) {
    if (!latest || owner.id > latest.id) latest = owner;
  }
  return latest;
}

/** Own topmost Escape dismissal and one share of the document scroll lock. */
export function useModalLayer(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  const ownerIdRef = useRef<number | null>(null);
  onCloseRef.current = onClose;
  if (ownerIdRef.current === null) {
    modalLayerOwnerSequence += 1;
    ownerIdRef.current = modalLayerOwnerSequence;
  }

  useEffect(() => {
    if (!enabled) return;
    const ownerId = ownerIdRef.current;
    if (ownerId === null) return;
    const owner = {
      id: ownerId,
      close: () => onCloseRef.current(),
    };
    const needsEscapeListener = modalLayerOwners.length === 0;
    modalLayerOwners.push(owner);
    if (needsEscapeListener) {
      document.addEventListener("keydown", handleModalEscape, true);
    }
    if (bodyScrollOwners === 0) {
      bodyOverflowBeforeModal = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    bodyScrollOwners += 1;

    return () => {
      const ownerIndex = modalLayerOwners.findIndex(
        (candidate) => candidate.id === owner.id,
      );
      if (ownerIndex >= 0) modalLayerOwners.splice(ownerIndex, 1);
      if (modalLayerOwners.length === 0) {
        document.removeEventListener("keydown", handleModalEscape, true);
      }
      bodyScrollOwners -= 1;
      if (bodyScrollOwners === 0) {
        document.body.style.overflow = bodyOverflowBeforeModal ?? "";
        bodyOverflowBeforeModal = null;
      }
    };
  }, [enabled]);
}

/** Own the topmost Backspace dismissal slot while a viewer is visible. */
export function useModalBackspace(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  const ownerIdRef = useRef<number | null>(null);
  onCloseRef.current = onClose;
  if (ownerIdRef.current === null) {
    modalBackspaceOwnerSequence += 1;
    ownerIdRef.current = modalBackspaceOwnerSequence;
  }

  useEffect(() => {
    if (!enabled) return;
    const ownerId = ownerIdRef.current;
    if (ownerId === null) return;
    const owner = {
      id: ownerId,
      close: () => onCloseRef.current(),
    };
    const needsListener = modalBackspaceOwners.length === 0;
    modalBackspaceOwners.push(owner);
    if (needsListener) {
      document.addEventListener("keydown", handleModalBackspace, true);
    }
    return () => {
      const ownerIndex = modalBackspaceOwners.findIndex(
        (candidate) => candidate.id === owner.id,
      );
      if (ownerIndex >= 0) modalBackspaceOwners.splice(ownerIndex, 1);
      if (modalBackspaceOwners.length === 0) {
        document.removeEventListener("keydown", handleModalBackspace, true);
      }
    };
  }, [enabled]);
}

function getHistoryState(): Record<string, unknown> {
  return window.history.state &&
    typeof window.history.state === "object" &&
    !Array.isArray(window.history.state)
    ? window.history.state
    : {};
}

/**
 * Own one same-URL history entry while a modal is open.
 *
 * Cleanup is deferred by a microtask so React Strict Mode's development-only
 * effect replay can cancel it during the immediate re-setup. A real unmount
 * still removes the entry, while a browser Back that already popped it only
 * closes the modal.
 */
export function useModalBackGesture(
  onClose: () => void,
  enabled = true,
  stateKey = "yaModal",
) {
  const onCloseRef = useRef(onClose);
  const ownsHistoryEntryRef = useRef(false);
  const cleanupGenerationRef = useRef(0);
  const historyEntryIdRef = useRef<string | null>(null);
  onCloseRef.current = onClose;
  if (historyEntryIdRef.current === null) {
    modalHistoryEntrySequence += 1;
    historyEntryIdRef.current = `${stateKey}-${modalHistoryEntrySequence}`;
  }

  useEffect(() => {
    if (!enabled) return;

    cleanupGenerationRef.current += 1;
    const historyEntryId = historyEntryIdRef.current;
    if (!ownsHistoryEntryRef.current) {
      window.history.pushState(
        { ...getHistoryState(), [stateKey]: historyEntryId },
        "",
      );
      ownsHistoryEntryRef.current = true;
    }

    const onPopState = () => {
      if (window.history.state?.[stateKey] === historyEntryId) {
        return;
      }
      ownsHistoryEntryRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      const cleanupGeneration = cleanupGenerationRef.current + 1;
      cleanupGenerationRef.current = cleanupGeneration;
      queueMicrotask(() => {
        if (
          cleanupGenerationRef.current !== cleanupGeneration ||
          !ownsHistoryEntryRef.current
        ) {
          return;
        }
        ownsHistoryEntryRef.current = false;
        if (window.history.state?.[stateKey] === historyEntryId) {
          window.history.back();
        }
      });
    };
  }, [enabled, stateKey]);
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key or clicking the overlay.
 */
export function Modal({
  title,
  actions,
  headerActionsClassName,
  headerClassName,
  children,
  onClose,
  onMinimize,
  minimized = false,
  anchorRect,
  anchorAtAnyWidth = false,
  closeOnBackGesture,
  closeOnBackspace,
  contentRef,
  variant,
}: ModalProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayPointerStartedOnOverlayRef = useRef(false);
  useModalBackGesture(onClose, Boolean(closeOnBackGesture && !minimized));
  useModalBackspace(onClose, Boolean(closeOnBackspace && !minimized));
  useModalLayer(onClose, !minimized);
  const isAnchored =
    !!anchorRect &&
    typeof window !== "undefined" &&
    (anchorAtAnyWidth ||
      window.innerWidth > ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX);
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);

  // Focus the close button on mount for accessibility
  useEffect(() => {
    if (minimized) return;
    closeButtonRef.current?.focus();
  }, [minimized]);

  useLayoutEffect(() => {
    if (!isAnchored || !anchorRect) {
      setAnchorStyle(null);
      return;
    }

    const updateAnchorPosition = () => {
      const modal = modalRef.current;
      if (!modal) return;

      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const modalWidth = Math.min(
        modal.offsetWidth,
        viewportWidth - ANCHORED_MODAL_MARGIN_PX * 2,
      );
      const modalHeight = Math.min(
        modal.offsetHeight,
        viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
      );
      const maxLeft = viewportWidth - modalWidth - ANCHORED_MODAL_MARGIN_PX;
      let left = anchorRect.right - modalWidth;
      left = Math.min(Math.max(ANCHORED_MODAL_MARGIN_PX, left), maxLeft);

      let top = anchorRect.bottom + ANCHORED_MODAL_MARGIN_PX;
      if (top + modalHeight > viewportHeight - ANCHORED_MODAL_MARGIN_PX) {
        top = anchorRect.top - modalHeight - ANCHORED_MODAL_MARGIN_PX;
      }
      top = Math.max(ANCHORED_MODAL_MARGIN_PX, top);

      setAnchorStyle({
        left,
        maxHeight: viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
        top,
        visibility: "visible",
      });
    };

    updateAnchorPosition();
    window.addEventListener("resize", updateAnchorPosition);
    window.visualViewport?.addEventListener("resize", updateAnchorPosition);
    return () => {
      window.removeEventListener("resize", updateAnchorPosition);
      window.visualViewport?.removeEventListener(
        "resize",
        updateAnchorPosition,
      );
    };
  }, [anchorRect, isAnchored]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if the whole click started and ended on the overlay.
    // Text selection can start inside the dialog and release outside it.
    if (
      e.target === e.currentTarget &&
      overlayPointerStartedOnOverlayRef.current
    ) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    overlayPointerStartedOnOverlayRef.current = false;
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    <div
      className={`modal-overlay${isAnchored ? " modal-overlay--anchored" : ""}${
        variant ? ` modal-overlay--${variant}` : ""
      }`}
      aria-hidden={minimized || undefined}
      style={minimized ? { display: "none" } : undefined}
      onClick={handleOverlayClick}
      onMouseDown={(e) => {
        overlayPointerStartedOnOverlayRef.current =
          e.target === e.currentTarget;
        e.stopPropagation();
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <div
        ref={modalRef}
        className={`modal${isAnchored ? " modal--anchored" : ""}${
          variant ? ` modal--${variant}` : ""
        }`}
        {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
        role="dialog"
        aria-modal="true"
        onClick={handleModalClick}
        style={
          isAnchored ? (anchorStyle ?? { visibility: "hidden" }) : undefined
        }
      >
        <div
          className={`modal-header${headerClassName ? ` ${headerClassName}` : ""}`}
        >
          <span className="modal-title">{title}</span>
          <span
            className={`modal-header-actions${
              headerActionsClassName ? ` ${headerActionsClassName}` : ""
            }`}
            style={
              headerActionsClassName
                ? undefined
                : {
                    display: "flex",
                    alignItems: "center",
                    gap: "0.375rem",
                    marginLeft: "auto",
                    flexShrink: 0,
                  }
            }
          >
            {actions}
            {onMinimize && (
              <button
                type="button"
                className="modal-close"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onMinimize();
                }}
                aria-label={t("modalMinimize")}
              >
                −
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              className="modal-close"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              aria-label={t("modalClose")}
            >
              ×
            </button>
          </span>
        </div>
        <div className="modal-content" ref={contentRef}>
          {children}
        </div>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}
