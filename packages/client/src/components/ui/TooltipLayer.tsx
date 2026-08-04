import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  areTooltipsSuppressed,
  beginTooltipVisibility,
  COMPOSER_TYPING_TOOLTIP_SUPPRESSION_MS,
  endTooltipVisibility,
  exceedsTooltipPointerJitter,
  getEffectiveTooltipDelayMs,
  getTooltipDelayMs,
  subscribeTooltipSuppression,
  suppressTooltipsFor,
  TOOLTIP_CLOSE_DELAY_MULTIPLIER,
  useTooltipMode,
} from "../../hooks/useTooltipAppearance";
import { writeClipboardText } from "../../lib/clipboard";
import { isElementFullyScrollVisible } from "../../lib/tooltipVisibility";
import styles from "./TooltipLayer.module.css";

const TOOLTIP_ID = "ya-global-tooltip";
const VIEWPORT_MARGIN_PX = 8;
const POINTER_OFFSET_PX = 14;

interface VisibleTooltip {
  text: string;
  anchorX: number;
  anchorY: number;
  forcedThemed: boolean;
}

interface PointerPosition {
  x: number;
  y: number;
}

interface DetachedTitle {
  value: string;
  injectedDataTooltip: boolean;
}

interface DetachedSvgTitle extends DetachedTitle {
  parent: Element;
  nextSibling: Node | null;
}

interface SavedDescription {
  target: Element;
  value: string | null;
}

function pointerCanHover(event: PointerEvent): boolean {
  return event.pointerType !== "touch";
}

function finiteCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function tooltipTargetFromNode(
  node: EventTarget | null,
  activeTarget: Element | null,
): Element | null {
  if (!(node instanceof Element)) return null;
  if (activeTarget?.contains(node)) return activeTarget;
  if (activeTarget && node.closest(`#${TOOLTIP_ID}`)) return activeTarget;
  return node.closest("[data-tooltip], [title]");
}

function isPointerJitter(
  event: PointerEvent,
  position: PointerPosition | null,
): boolean {
  return !exceedsTooltipPointerJitter(
    position,
    event.clientX,
    event.clientY,
  );
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function repeatsFullyVisibleContent(target: Element, text: string): boolean {
  const normalizedText = normalizeVisibleText(text);
  if (
    normalizeVisibleText(target.textContent ?? "") !== normalizedText
  ) {
    return false;
  }
  if (!(target instanceof HTMLElement)) return false;
  if (!isElementFullyScrollVisible(target)) return false;

  // A row can fit while the one descendant carrying that same text is
  // ellipsized. Suppress only when every exact-text presentation is visible.
  for (const descendant of target.querySelectorAll<HTMLElement>("*")) {
    if (
      normalizeVisibleText(descendant.textContent ?? "") === normalizedText &&
      !isElementFullyScrollVisible(descendant)
    ) {
      return false;
    }
  }
  return true;
}

function appendDescriptionId(target: Element): SavedDescription {
  const value = target.getAttribute("aria-describedby");
  const ids = new Set(value?.split(/\s+/).filter(Boolean) ?? []);
  ids.add(TOOLTIP_ID);
  target.setAttribute("aria-describedby", [...ids].join(" "));
  return { target, value };
}

function restoreDescription(saved: SavedDescription | null): void {
  if (!saved?.target.isConnected) return;
  if (saved.value === null) {
    saved.target.removeAttribute("aria-describedby");
  } else {
    saved.target.setAttribute("aria-describedby", saved.value);
  }
}

function hasSelectedText(): boolean {
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString() !== "";
}

function isContextMenuOperable(event: MouseEvent): boolean {
  if (event.defaultPrevented || hasSelectedText()) return true;
  if (!(event.target instanceof Element)) return false;
  return (
    event.target.closest(
      'a[href], input, textarea, select, [contenteditable="true"], img, video, audio, [data-context-menu]',
    ) !== null
  );
}

/**
 * One delegated text-tooltip layer covers existing `title=` affordances and
 * explicit `data-tooltip` targets without forcing every renderer to own
 * positioning, dwell, adjacency, and accessibility state.
 */
export function TooltipLayer() {
  const tooltipMode = useTooltipMode();
  const [visible, setVisible] = useState<VisibleTooltip | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTargetRef = useRef<Element | null>(null);
  const movementDismissedTargetRef = useRef<Element | null>(null);
  const detachedTitlesRef = useRef(new Map<Element, DetachedTitle>());
  const detachedSvgTitlesRef = useRef(new Map<Element, DetachedSvgTitle>());
  const savedDescriptionRef = useRef<SavedDescription | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTokenRef = useRef<symbol | null>(null);
  const lastPointerPositionRef = useRef<PointerPosition | null>(null);
  const visibleRef = useRef(false);
  const visibleTooltipRef = useRef<VisibleTooltip | null>(visible);
  visibleRef.current = visible !== null;
  visibleTooltipRef.current = visible;

  const clearShowTimer = useCallback(() => {
    if (!showTimerRef.current) return;
    clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const restoreDetachedTitles = useCallback(() => {
    for (const [target, saved] of detachedTitlesRef.current) {
      if (!target.isConnected) continue;
      if (!target.getAttribute("title")) {
        target.setAttribute("title", saved.value);
      }
      if (
        saved.injectedDataTooltip &&
        target.getAttribute("data-tooltip") === saved.value
      ) {
        target.removeAttribute("data-tooltip");
      }
    }
    detachedTitlesRef.current.clear();
    for (const [title, saved] of detachedSvgTitlesRef.current) {
      if (!saved.parent.isConnected) continue;
      if (!saved.parent.querySelector(":scope > title")) {
        const nextSibling =
          saved.nextSibling?.parentNode === saved.parent
            ? saved.nextSibling
            : null;
        saved.parent.insertBefore(title, nextSibling);
      }
      if (
        saved.injectedDataTooltip &&
        saved.parent.getAttribute("data-tooltip") === saved.value
      ) {
        saved.parent.removeAttribute("data-tooltip");
      }
    }
    detachedSvgTitlesRef.current.clear();
  }, []);

  const detachTitle = useCallback((target: Element): string => {
    const liveTitle = target.getAttribute("title");
    if (liveTitle === null) {
      return detachedTitlesRef.current.get(target)?.value ?? "";
    }
    const existing = detachedTitlesRef.current.get(target);
    if (liveTitle === "") {
      return existing?.value ?? "";
    }
    const injectedDataTooltip =
      existing?.injectedDataTooltip ??
      !target.hasAttribute("data-tooltip");
    detachedTitlesRef.current.set(target, {
      value: liveTitle,
      injectedDataTooltip,
    });
    if (injectedDataTooltip) {
      target.setAttribute("data-tooltip", liveTitle);
    }
    target.setAttribute("title", "");
    return liveTitle;
  }, []);

  const detachSvgTitle = useCallback((title: Element): void => {
    const parent = title.parentElement;
    const value = title.textContent?.trim() ?? "";
    if (parent?.localName !== "svg" || !value) return;
    const injectedDataTooltip = !parent.hasAttribute("data-tooltip");
    detachedSvgTitlesRef.current.set(title, {
      parent,
      nextSibling: title.nextSibling,
      value,
      injectedDataTooltip,
    });
    if (injectedDataTooltip) {
      parent.setAttribute("data-tooltip", value);
    }
    title.remove();
  }, []);

  const releaseVisibility = useCallback(() => {
    const token = visibilityTokenRef.current;
    visibilityTokenRef.current = null;
    if (token) endTooltipVisibility(token);
    restoreDescription(savedDescriptionRef.current);
    savedDescriptionRef.current = null;
  }, []);

  const clearActive = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    releaseVisibility();
    activeTargetRef.current = null;
    visibleRef.current = false;
    visibleTooltipRef.current = null;
    setEnlarged(false);
    setVisible(null);
  }, [clearHideTimer, clearShowTimer, releaseVisibility]);

  const hide = clearActive;
  const dismissUntilDeparture = clearActive;

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) return;
    const delayMs =
      getTooltipDelayMs() * TOOLTIP_CLOSE_DELAY_MULTIPLIER;
    if (delayMs === 0) {
      hide();
      return;
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      hide();
    }, delayMs);
  }, [hide]);

  const show = useCallback(
    (
      target: Element,
      anchorX: number,
      anchorY: number,
      forcedThemed = false,
    ) => {
      showTimerRef.current = null;
      if (activeTargetRef.current !== target || !target.isConnected) return;
      const currentText =
        target.getAttribute("data-tooltip") ??
        (forcedThemed
          ? (target.getAttribute("title") ?? "")
          : detachTitle(target));
      if (!currentText.trim()) return;
      if (repeatsFullyVisibleContent(target, currentText)) {
        movementDismissedTargetRef.current = target;
        dismissUntilDeparture();
        return;
      }
      visibilityTokenRef.current ??= beginTooltipVisibility(hide);
      restoreDescription(savedDescriptionRef.current);
      savedDescriptionRef.current = appendDescriptionId(target);
      visibleRef.current = true;
      const resolvedAnchorX = finiteCoordinate(anchorX);
      const resolvedAnchorY = finiteCoordinate(anchorY);
      setPosition({
        left: resolvedAnchorX + POINTER_OFFSET_PX,
        top: resolvedAnchorY + POINTER_OFFSET_PX,
      });
      setVisible({
        text: currentText,
        anchorX: resolvedAnchorX,
        anchorY: resolvedAnchorY,
        forcedThemed,
      });
    },
    [detachTitle, dismissUntilDeparture, hide],
  );

  const schedule = useCallback(
    (target: Element, anchorX: number, anchorY: number) => {
      clearShowTimer();
      const delayMs = getEffectiveTooltipDelayMs();
      if (delayMs === 0) {
        show(target, anchorX, anchorY);
      } else {
        showTimerRef.current = setTimeout(
          () => show(target, anchorX, anchorY),
          delayMs,
        );
      }
    },
    [clearShowTimer, show],
  );

  const activate = useCallback(
    (target: Element, anchorX: number, anchorY: number) => {
      if (areTooltipsSuppressed()) {
        hide();
        return;
      }
      clearHideTimer();
      const changesTarget = target !== activeTargetRef.current;
      const switchesVisibleTooltip = changesTarget && visibleRef.current;
      if (changesTarget) {
        if (switchesVisibleTooltip) {
          clearShowTimer();
          setEnlarged(false);
        } else {
          hide();
        }
        activeTargetRef.current = target;
      }
      const title = detachTitle(target);
      const text = target.getAttribute("data-tooltip") ?? title;
      if (!text.trim()) {
        hide();
        return;
      }
      if (repeatsFullyVisibleContent(target, text)) {
        movementDismissedTargetRef.current = target;
        dismissUntilDeparture();
        return;
      }
      if (switchesVisibleTooltip) {
        show(target, anchorX, anchorY);
        return;
      }
      if (!visibleRef.current) schedule(target, anchorX, anchorY);
    },
    [
      clearHideTimer,
      clearShowTimer,
      detachTitle,
      dismissUntilDeparture,
      hide,
      schedule,
      show,
    ],
  );

  useEffect(() => subscribeTooltipSuppression(hide), [hide]);

  useEffect(() => {
    const glossaryTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      const target = node.closest<HTMLElement>("[data-glossary-term]");
      return target?.dataset.tooltip || target?.title ? target : null;
    };
    const revealAndCopy = (
      target: HTMLElement,
      anchorX: number,
      anchorY: number,
    ) => {
      if (hasSelectedText()) return;
      hide();
      activeTargetRef.current = target;
      show(target, anchorX, anchorY, true);
      void writeClipboardText(target.dataset.tooltip ?? target.title);
    };
    const onClick = (event: MouseEvent) => {
      const target = glossaryTarget(event.target);
      if (!target || hasSelectedText()) return;
      event.preventDefault();
      revealAndCopy(target, event.clientX, event.clientY);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && visibleTooltipRef.current?.forcedThemed) {
        hide();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = glossaryTarget(event.target);
      if (!target) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      revealAndCopy(target, rect.left + rect.width / 2, rect.bottom);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!visibleTooltipRef.current?.forcedThemed) return;
      const activeTarget = activeTargetRef.current;
      if (
        event.target instanceof Node &&
        (activeTarget?.contains(event.target) ||
          tooltipRef.current?.contains(event.target))
      ) {
        return;
      }
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (tooltipMode !== "native") return;
      const target = glossaryTarget(event.target);
      if (!target?.matches(":focus-visible")) return;
      hide();
      activeTargetRef.current = target;
      const rect = target.getBoundingClientRect();
      show(target, rect.left + rect.width / 2, rect.bottom, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!visibleTooltipRef.current?.forcedThemed) return;
      if (
        event.relatedTarget instanceof Node &&
        activeTargetRef.current?.contains(event.relatedTarget)
      ) {
        return;
      }
      hide();
    };

    // Glossary terms also appear inside dialogs whose click boundaries stop
    // bubbling. Capture activation so the same term interaction works in
    // file-viewer modals and ordinary rendered prose.
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [hide, show, tooltipMode]);

  useEffect(() => {
    const onComposerInput = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches("[data-composer-input]")
      ) {
        return;
      }
      suppressTooltipsFor(COMPOSER_TYPING_TOOLTIP_SUPPRESSION_MS);
    };

    document.addEventListener("beforeinput", onComposerInput, true);
    document.addEventListener("input", onComposerInput, true);
    return () => {
      document.removeEventListener("beforeinput", onComposerInput, true);
      document.removeEventListener("input", onComposerInput, true);
    };
  }, []);

  useEffect(() => {
    if (tooltipMode !== "themed") {
      movementDismissedTargetRef.current = null;
      hide();
      return;
    }

    const detachTitlesWithin = (node: Node) => {
      if (node instanceof Element && node.hasAttribute("title")) {
        detachTitle(node);
      }
      if (node instanceof Element || node instanceof Document) {
        for (const target of node.querySelectorAll("[title]")) {
          detachTitle(target);
        }
        if (
          node instanceof Element &&
          node.localName === "title" &&
          node.parentElement?.localName === "svg"
        ) {
          detachSvgTitle(node);
        }
        for (const title of node.querySelectorAll("svg > title")) {
          detachSvgTitle(title);
        }
      }
    };
    const forgetDetachedTitlesWithin = (node: Node) => {
      if (node instanceof Element) {
        detachedTitlesRef.current.delete(node);
        for (const target of node.querySelectorAll("*")) {
          detachedTitlesRef.current.delete(target);
        }
        for (const [title, saved] of detachedSvgTitlesRef.current) {
          if (node === saved.parent || node.contains(saved.parent)) {
            detachedSvgTitlesRef.current.delete(title);
          }
        }
      }
    };
    const forgetRemovedTitle = (target: Element) => {
      const saved = detachedTitlesRef.current.get(target);
      if (!saved) return;
      detachedTitlesRef.current.delete(target);
      if (
        saved.injectedDataTooltip &&
        target.getAttribute("data-tooltip") === saved.value
      ) {
        target.removeAttribute("data-tooltip");
      }
      if (activeTargetRef.current === target) {
        hide();
      }
    };
    detachTitlesWithin(document);
    const titleObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof Element) {
            if (mutation.target.hasAttribute("title")) {
              if (
                mutation.target.getAttribute("title") === "" &&
                mutation.oldValue === ""
              ) {
                forgetRemovedTitle(mutation.target);
              } else {
                detachTitle(mutation.target);
              }
            } else {
              forgetRemovedTitle(mutation.target);
            }
          }
          continue;
        }
        for (const node of mutation.removedNodes) {
          forgetDetachedTitlesWithin(node);
        }
        for (const node of mutation.addedNodes) {
          detachTitlesWithin(node);
        }
      }
    });
    titleObserver.observe(document.documentElement, {
      attributeFilter: ["title"],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });

    const onPointerOver = (event: PointerEvent) => {
      if (!pointerCanHover(event)) return;
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        event.target instanceof Node &&
        dismissedTarget.contains(event.target)
      ) {
        return;
      }
      movementDismissedTargetRef.current = null;
      const target = tooltipTargetFromNode(
        event.target,
        activeTargetRef.current,
      );
      if (!target) return;
      if (
        visibleRef.current &&
        target !== activeTargetRef.current &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      activate(target, event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerCanHover(event)) return;
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        event.target instanceof Node &&
        dismissedTarget.contains(event.target)
      ) {
        return;
      }
      const target = tooltipTargetFromNode(
        event.target,
        activeTargetRef.current,
      );
      if (!target) {
        if (visibleRef.current) {
          if (
            isPointerJitter(event, lastPointerPositionRef.current)
          ) {
            return;
          }
          scheduleHide();
        } else {
          hide();
        }
        return;
      }
      if (
        visibleRef.current &&
        target !== activeTargetRef.current &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      clearHideTimer();
      if (movementDismissedTargetRef.current === target) return;
      activate(target, event.clientX, event.clientY);
    };
    const onPointerOut = (event: PointerEvent) => {
      const activeTarget = activeTargetRef.current;
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        !(
          event.relatedTarget instanceof Node &&
          dismissedTarget.contains(event.relatedTarget)
        )
      ) {
        movementDismissedTargetRef.current = null;
      }
      if (!activeTarget) return;
      const eventTarget =
        event.target instanceof Node ? event.target : null;
      const tooltip = tooltipRef.current;
      const leftActiveRegion =
        !!eventTarget &&
        (activeTarget.contains(eventTarget) ||
          !!tooltip?.contains(eventTarget));
      if (!leftActiveRegion) return;
      if (
        event.relatedTarget instanceof Node &&
        (activeTarget.contains(event.relatedTarget) ||
          !!tooltip?.contains(event.relatedTarget))
      ) {
        clearHideTimer();
        return;
      }
      if (
        visibleRef.current &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      if (visibleRef.current) scheduleHide();
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTargetFromNode(
        event.target,
        activeTargetRef.current,
      );
      if (!target?.matches(":focus-visible")) return;
      const rect = target.getBoundingClientRect();
      activate(target, rect.left + rect.width / 2, rect.bottom);
    };
    const onFocusOut = (event: FocusEvent) => {
      const activeTarget = activeTargetRef.current;
      if (
        activeTarget &&
        event.relatedTarget instanceof Node &&
        activeTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      movementDismissedTargetRef.current = null;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const activeTarget = activeTargetRef.current;
      if (!activeTarget) return;
      movementDismissedTargetRef.current = activeTarget;
      dismissUntilDeparture();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2) {
        if (
          event.target instanceof Node &&
          tooltipRef.current?.contains(event.target)
        ) {
          return;
        }
        movementDismissedTargetRef.current = activeTargetRef.current;
        dismissUntilDeparture();
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      const currentTooltip = visibleTooltipRef.current;
      const activeTarget = activeTargetRef.current;
      const tooltip = tooltipRef.current;
      if (
        !currentTooltip ||
        !activeTarget ||
        !(event.target instanceof Node) ||
        (!activeTarget.contains(event.target) &&
          !tooltip?.contains(event.target)) ||
        isContextMenuOperable(event)
      ) {
        return;
      }
      event.preventDefault();
      setEnlarged(true);
      void writeClipboardText(currentTooltip.text);
    };
    const handleScroll = () => {
      if (!visibleRef.current && activeTargetRef.current) hide();
    };
    const handleResize = () => {
      if (!visibleRef.current) {
        if (activeTargetRef.current) hide();
        return;
      }
      setVisible((current) => (current ? { ...current } : current));
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("blur", hide);
    return () => {
      titleObserver.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("blur", hide);
      hide();
      restoreDetachedTitles();
    };
  }, [
    activate,
    clearHideTimer,
    detachTitle,
    detachSvgTitle,
    dismissUntilDeparture,
    hide,
    restoreDetachedTitles,
    scheduleHide,
    tooltipMode,
  ]);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element || !visible) return;
    const rect = element.getBoundingClientRect();
    let left = visible.anchorX + POINTER_OFFSET_PX;
    let top = visible.anchorY + POINTER_OFFSET_PX;
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = visible.anchorX - rect.width - POINTER_OFFSET_PX;
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN_PX) {
      top = visible.anchorY - rect.height - POINTER_OFFSET_PX;
    }
    setPosition({
      left: Math.max(VIEWPORT_MARGIN_PX, left),
      top: Math.max(VIEWPORT_MARGIN_PX, top),
    });
  }, [visible]);

  if ((!visible?.forcedThemed && tooltipMode !== "themed") || !visible) {
    return null;
  }
  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className={`${styles.root}${enlarged ? ` ${styles.enlarged}` : ""}`}
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      {visible.text}
    </div>,
    document.body,
  );
}
