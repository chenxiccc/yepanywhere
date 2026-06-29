import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

const ANCHORED_MODAL_MARGIN_PX = 8;
const ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX = 600;

/**
 * Global stack of backCloses modal IDs, ordered by open time.
 * Only the topmost (last) modal responds to popstate so a single back gesture
 * closes one modal at a time even when modals are nested.
 *
 * 全局 backCloses modal 的 ID 栈，按打开顺序排列。只有栈顶（最后一个）modal
 * 响应 popstate，确保嵌套 modal 时一次返回手势只关闭一层。
 */
let modalIdSeq = 0;
const modalStack: number[] = [];

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
  children: ReactNode;
  onClose: () => void;
  anchorRect?: ModalAnchorRect | null;
  /**
   * When true, the browser's back gesture (swipe back on mobile) closes the
   * modal instead of navigating away from the page. Opens by pushing a
   * history entry and closes on popstate.
   */
  backCloses?: boolean;
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key or clicking the overlay.
 */
export function Modal({ title, children, onClose, anchorRect, backCloses }: ModalProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayPointerStartedOnOverlayRef = useRef(false);
  // Unique id for this modal instance in the global backCloses stack.
  // 当前 modal 实例在全局 backCloses 栈中的唯一标识。
  const modalIdRef = useRef<number | null>(null);
  const backClosesPushedRef = useRef(false);
  const closingViaPopstateRef = useRef(false);
  const isAnchored =
    !!anchorRect &&
    typeof window !== "undefined" &&
    window.innerWidth > ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX;
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);

  // Cache onClose in a ref so the pushState effect doesn't re-run on
  // reference change (e.g. inline arrow functions on every render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Back gesture closes modal: pushes a history entry on open; popstate
  // closes the modal instead of navigating away from the page.
  // Uses a global modal stack so only the topmost backCloses modal responds
  // to a single back gesture, even when modals are nested.
  //
  // 移动端返回手势关闭 modal：打开时 push 一个 history entry，popstate 时关闭
  // modal 而不是离开页面。使用全局 modal 栈确保嵌套 modal 时一次返回只关闭一层。
  useEffect(() => {
    if (!backCloses) return;

    const modalId = ++modalIdSeq;
    modalIdRef.current = modalId;
    modalStack.push(modalId);
    window.history.pushState({ __modal: true }, "");
    backClosesPushedRef.current = true;

    const handlePopState = () => {
      // Only the topmost modal in the stack responds to popstate.
      // popstate event.state 是导航到的 entry，不是离开的 entry。
      // 用 ref 确认本实例 push 过 entry，且栈顶是当前 modal。
      if (
        backClosesPushedRef.current &&
        modalStack.length > 0 &&
        modalStack[modalStack.length - 1] === modalId
      ) {
        closingViaPopstateRef.current = true;
        backClosesPushedRef.current = false;
        // Remove from stack before calling onClose so the parent
        // modal (if any) becomes the new top.
        // 在调用 onClose 前从栈中移除，让父 modal 成为新的栈顶。
        const idx = modalStack.indexOf(modalId);
        if (idx >= 0) modalStack.splice(idx, 1);
        onCloseRef.current();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      // Clean up: remove from global stack and clear any pushed history
      // entry that may have been left behind (e.g. child closed via a
      // non-Modal close path like a toolbar button).
      //
      // 清理：从全局栈中移除，并清理可能残留的 history entry
      // （例如子 modal 通过非 Modal 关闭路径关闭，如工具栏按钮）。
      const idx = modalStack.indexOf(modalId);
      if (idx >= 0) modalStack.splice(idx, 1);
      if (backClosesPushedRef.current) {
        backClosesPushedRef.current = false;
        if (!closingViaPopstateRef.current) {
          window.history.back();
        }
        closingViaPopstateRef.current = false;
      }
    };
  }, [backCloses]);

  // Wrapped close: removes the pushed history entry on manual close, then
  // calls the parent onClose.
  const close = useCallback(() => {
    if (backCloses && backClosesPushedRef.current) {
      backClosesPushedRef.current = false;
      if (!closingViaPopstateRef.current) {
        window.history.back();
      }
      closingViaPopstateRef.current = false;
    }
    onCloseRef.current();
  }, [backCloses]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [close]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Focus the close button on mount for accessibility
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

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
      close();
    }
    overlayPointerStartedOnOverlayRef.current = false;
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the modal; Escape is handled globally
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally, click is for overlay dismiss
    <div
      className={`modal-overlay${isAnchored ? " modal-overlay--anchored" : ""}`}
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
        className={`modal${isAnchored ? " modal--anchored" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={handleModalClick}
        style={
          isAnchored ? (anchorStyle ?? { visibility: "hidden" }) : undefined
        }
      >
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="modal-close"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
            aria-label={t("modalClose")}
          >
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}