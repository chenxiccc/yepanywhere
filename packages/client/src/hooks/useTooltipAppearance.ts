import {
  type PointerEventHandler,
  useCallback,
  useSyncExternalStore,
} from "react";
import {
  createLocalStorageValue,
  invalidateLocalStorageValues,
} from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";
import { getVisibilityAwareTooltipText } from "../lib/tooltipVisibility";

export type TooltipMode = "themed" | "native";

export interface TextTooltipAttributes {
  title?: string;
  "data-tooltip"?: string;
}

export const TOOLTIP_DELAY_MIN_MS = 0;
export const TOOLTIP_DELAY_MAX_MS = 1000;
export const TOOLTIP_DELAY_STEP_MS = 10;
export const DEFAULT_TOOLTIP_DELAY_MS = 50;

/** Larger session previews should not open during a casual pass over a list. */
export const SESSION_HOVERCARD_DELAY_MULTIPLIER = 3;

/**
 * Leaving a trigger is noisier than entering one: a short grace period keeps
 * the tooltip reachable across its visual gap without making dismissal feel
 * sticky.
 */
export const TOOLTIP_CLOSE_DELAY_MULTIPLIER = 2;

/** Ignore residual hand/sensor motion near a tooltip hover boundary. */
export const TOOLTIP_POINTER_JITTER_PX = 4;

/** Keep pointer re-hit events quiet across at least one typing cadence. */
export const COMPOSER_TYPING_TOOLTIP_SUPPRESSION_MS = 100;

/**
 * Once a tooltip has opened, a short time-only adjacency window makes scanning
 * neighboring targets immediate. Targets merely crossed before opening do not
 * warm the system.
 */
export const TOOLTIP_WARM_GRACE_MULTIPLIER = 6;

const visibleTooltipTokens = new Set<symbol>();
const visibleTooltipDismissers = new Map<symbol, () => void>();
const tooltipSuppressionListeners = new Set<() => void>();
let warmUntilMs = 0;
let tooltipSuppressedUntilMs = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTooltipDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TOOLTIP_DELAY_MS;
  return clamp(
    Math.round(value / TOOLTIP_DELAY_STEP_MS) * TOOLTIP_DELAY_STEP_MS,
    TOOLTIP_DELAY_MIN_MS,
    TOOLTIP_DELAY_MAX_MS,
  );
}

const tooltipModeStore = createLocalStorageValue<TooltipMode>(
  UI_KEYS.tooltipMode,
  "themed",
  (raw) => (raw === "native" ? "native" : "themed"),
);

const tooltipDelayStore = createLocalStorageValue(
  UI_KEYS.tooltipDelayMs,
  DEFAULT_TOOLTIP_DELAY_MS,
  (raw) => normalizeTooltipDelay(Number(raw)),
  String,
  {
    relatedKeys: [UI_KEYS.sessionHoverCardShowDelayMs],
    readFallback: (storage) => {
      const raw = storage.getItem(UI_KEYS.sessionHoverCardShowDelayMs);
      return raw === null
        ? undefined
        : normalizeTooltipDelay(
            Number(raw) / SESSION_HOVERCARD_DELAY_MULTIPLIER,
          );
    },
  },
);

export function getTooltipMode(): TooltipMode {
  return tooltipModeStore.read();
}

/**
 * A text hint has exactly one presentation owner. Themed mode delegates
 * through `data-tooltip`; native mode gives the browser a `title`.
 */
export function getTextTooltipAttributes(
  text: string | null | undefined,
  mode: TooltipMode = getTooltipMode(),
): TextTooltipAttributes {
  if (!text) return {};
  return mode === "themed" ? { "data-tooltip": text } : { title: text };
}

/**
 * Pointer-computed hints use the same exclusive attribute contract as static
 * hints. Removing both first also clears a stale attribute after a mode change.
 */
export function setElementTextTooltip(
  target: Element,
  text: string | null | undefined,
  mode: TooltipMode = getTooltipMode(),
): void {
  target.removeAttribute("title");
  target.removeAttribute("data-tooltip");
  if (!text) return;
  if (mode === "themed") {
    target.setAttribute("data-tooltip", text);
  } else {
    target.setAttribute("title", text);
  }
}

/**
 * The retired hover-card delay seeds the shared base at one third of its old
 * value, preserving the existing card timing for browsers that customized it.
 */
export function getTooltipDelayMs(): number {
  return tooltipDelayStore.read();
}

function applyTooltipDelayCssVariable(delayMs: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--tooltip-delay-ms",
    `${delayMs}ms`,
  );
  document.documentElement.dataset.tooltipMode = getTooltipMode();
}

function subscribe(listener: () => void): () => void {
  const handleChange = () => {
    applyTooltipDelayCssVariable(getTooltipDelayMs());
    listener();
  };
  const unsubscribeMode = tooltipModeStore.subscribe(handleChange);
  const unsubscribeDelay = tooltipDelayStore.subscribe(handleChange);
  return () => {
    unsubscribeMode();
    unsubscribeDelay();
  };
}

export function initializeTooltipAppearance(): void {
  applyTooltipDelayCssVariable(getTooltipDelayMs());
}

export function useTooltipDelayMs(): number {
  return useSyncExternalStore(
    subscribe,
    getTooltipDelayMs,
    () => DEFAULT_TOOLTIP_DELAY_MS,
  );
}

export function useTooltipMode(): TooltipMode {
  return useSyncExternalStore(
    subscribe,
    getTooltipMode,
    () => "themed" as const,
  );
}

export function useTooltipAppearance() {
  const tooltipMode = useTooltipMode();
  const tooltipDelayMs = useTooltipDelayMs();

  const setTooltipMode = useCallback((value: TooltipMode) => {
    tooltipModeStore.set(value);
    warmUntilMs = 0;
    applyTooltipDelayCssVariable(getTooltipDelayMs());
  }, []);

  const setTooltipDelayMs = useCallback((value: number) => {
    const normalized = normalizeTooltipDelay(value);
    try {
      localStorage.removeItem(UI_KEYS.sessionHoverCardShowDelayMs);
      invalidateLocalStorageValues(UI_KEYS.sessionHoverCardShowDelayMs);
    } catch {
      // This browser-local presentation preference may remain at its default
      // when persistence is unavailable.
    }
    tooltipDelayStore.set(normalized);
    tooltipModeStore.set("themed");
    warmUntilMs = 0;
    applyTooltipDelayCssVariable(normalized);
  }, []);

  const resetTooltipDelayMs = useCallback(() => {
    try {
      localStorage.removeItem(UI_KEYS.sessionHoverCardShowDelayMs);
      invalidateLocalStorageValues(UI_KEYS.sessionHoverCardShowDelayMs);
    } catch {
      // See setTooltipDelayMs.
    }
    tooltipDelayStore.reset();
    warmUntilMs = 0;
    applyTooltipDelayCssVariable(getTooltipDelayMs());
  }, []);

  return {
    tooltipMode,
    tooltipDelayMs,
    setTooltipMode,
    setTooltipDelayMs,
    resetTooltipDelayMs,
  };
}

/** Reactive attributes for render-time tooltip text. */
export function useTextTooltipAttributes(
  text: string | null | undefined,
): TextTooltipAttributes {
  const tooltipMode = useTooltipMode();
  return getTextTooltipAttributes(text, tooltipMode);
}

/**
 * Preview surfaces show their explicit omitted tail when truncated. If they
 * have no truncation marker, pointer entry measures the rendered content and
 * exposes the full text only when that surface is not fully scroll-visible.
 */
export function useVisibilityAwareTextTooltip<T extends HTMLElement>(
  fullText: string | null | undefined,
  omittedContentPreview?: string | null,
  visibilitySelector?: string,
): TextTooltipAttributes & { onPointerEnter: PointerEventHandler<T> } {
  const tooltipMode = useTooltipMode();
  const attributes = getTextTooltipAttributes(
    omittedContentPreview,
    tooltipMode,
  );
  const onPointerEnter = useCallback<PointerEventHandler<T>>(
    (event) => {
      const visibilityTarget =
        (visibilitySelector
          ? event.currentTarget.querySelector<HTMLElement>(visibilitySelector)
          : null) ?? event.currentTarget;
      setElementTextTooltip(
        event.currentTarget,
        getVisibilityAwareTooltipText(
          visibilityTarget,
          fullText,
          omittedContentPreview,
        ),
        tooltipMode,
      );
    },
    [
      fullText,
      omittedContentPreview,
      tooltipMode,
      visibilitySelector,
    ],
  );
  return { ...attributes, onPointerEnter };
}

export function isTooltipWarm(nowMs = Date.now()): boolean {
  return visibleTooltipTokens.size > 0 || nowMs <= warmUntilMs;
}

export function areTooltipsSuppressed(nowMs = Date.now()): boolean {
  return nowMs < tooltipSuppressedUntilMs;
}

export function subscribeTooltipSuppression(
  listener: () => void,
): () => void {
  tooltipSuppressionListeners.add(listener);
  return () => tooltipSuppressionListeners.delete(listener);
}

export function suppressTooltipsFor(
  durationMs: number,
  nowMs = Date.now(),
): void {
  tooltipSuppressedUntilMs = Math.max(
    tooltipSuppressedUntilMs,
    nowMs + Math.max(0, durationMs),
  );
  const dismissers = new Set([
    ...tooltipSuppressionListeners,
    ...visibleTooltipDismissers.values(),
  ]);
  visibleTooltipDismissers.clear();
  visibleTooltipTokens.clear();
  for (const dismiss of dismissers) dismiss();
  warmUntilMs = 0;
}

export function getEffectiveTooltipDelayMs(
  multiplier = 1,
  nowMs = Date.now(),
): number {
  return isTooltipWarm(nowMs)
    ? 0
    : Math.round(getTooltipDelayMs() * multiplier);
}

export function exceedsTooltipPointerJitter(
  origin: { readonly x: number; readonly y: number } | null,
  x: number,
  y: number,
): boolean {
  return (
    origin === null ||
    Math.hypot(x - origin.x, y - origin.y) > TOOLTIP_POINTER_JITTER_PX
  );
}

export function beginTooltipVisibility(onSuperseded?: () => void): symbol {
  const supersededDismissers = [...visibleTooltipDismissers.values()];
  visibleTooltipDismissers.clear();
  visibleTooltipTokens.clear();

  const token = Symbol("visible-tooltip");
  visibleTooltipTokens.add(token);
  if (onSuperseded) visibleTooltipDismissers.set(token, onSuperseded);
  for (const dismiss of supersededDismissers) dismiss();
  return token;
}

export function endTooltipVisibility(
  token: symbol,
  nowMs = Date.now(),
): void {
  visibleTooltipDismissers.delete(token);
  if (!visibleTooltipTokens.delete(token) || visibleTooltipTokens.size > 0) {
    return;
  }
  warmUntilMs =
    nowMs + getTooltipDelayMs() * TOOLTIP_WARM_GRACE_MULTIPLIER;
}

/** Clears process-local hover state after navigation/tests or a hard reset. */
export function clearTooltipWarmth(): void {
  visibleTooltipDismissers.clear();
  visibleTooltipTokens.clear();
  warmUntilMs = 0;
  tooltipSuppressedUntilMs = 0;
}
