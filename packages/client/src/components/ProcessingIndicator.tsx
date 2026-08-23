import {
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getFunPhrasesEnabled } from "../hooks/useFunPhrases";
import { useI18n } from "../i18n";
import { ThinkingIndicator } from "./ThinkingIndicator";

const PROCESSING_PHRASES = [
  "Thinking...",
  "Processing...",
  "Cooking...",
  "Analyzing...",
  "Working on it...",
  "Pondering...",
  "Computing...",
  "Crafting...",
  "Mulling it over...",
  "On it...",
  "Crunching...",
  "Brewing...",
  "Conjuring...",
  "Synthesizing...",
  "Deliberating...",
  "Ruminating...",
  "Contemplating...",
  "Percolating...",
  "Cogitating...",
  "Noodling...",
];

const ROTATION_INTERVAL_MS = 2000;
const TYPEWRITER_SPEED_MS = 25; // ~40 chars/second = ~240 WPM

/** Fisher-Yates shuffle */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j] as T;
    result[j] = temp as T;
  }
  return result;
}

interface Props {
  isProcessing: boolean;
  thinkingItemsVisible?: boolean;
  hasThinkingItems?: boolean;
  onToggleThinkingItemsVisible?: () => void;
  /** Auto-expand policy: true = only the latest block, false = every new one. */
  thinkingLatestOnly?: boolean;
  /**
   * Right-click / long-press: from hidden or latest-only, show thinking and
   * expand the full history; from everything-expanded, back to latest-only.
   */
  onToggleThinkingLatestOnly?: () => void;
}

function ThoughtTranscriptIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className="processing-thinking-toggle-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11.5c0 4-3.8 7.25-8.5 7.25-1.1 0-2.2-.18-3.15-.52L4 20l1.2-3.25C3.85 15.42 3 13.58 3 11.5 3 7.5 6.8 4.25 11.5 4.25S20 7.5 20 11.5Z" />
      <path d="M8.5 11.5h.01" />
      <path d="M11.5 11.5h.01" />
      <path d="M14.5 11.5h.01" />
      {muted && (
        <path className="processing-thinking-toggle-slash" d="M4 20 20 4" />
      )}
    </svg>
  );
}

export const ProcessingIndicator = memo(function ProcessingIndicator({
  isProcessing,
  thinkingItemsVisible = true,
  hasThinkingItems = false,
  onToggleThinkingItemsVisible,
  thinkingLatestOnly = false,
  onToggleThinkingLatestOnly,
}: Props) {
  const { t } = useI18n();
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const [isAnimationPaused, setIsAnimationPaused] = useState(false);
  const showThinkingToggle = Boolean(
    onToggleThinkingItemsVisible && (isProcessing || hasThinkingItems),
  );

  // Right-click (desktop) / long-press (touch) flips the auto-expand policy;
  // left-click still toggles visibility. suppressTouchClickRef stops a
  // completed long-press from also firing the click handler.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTouchClickRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!onToggleThinkingLatestOnly) return;
      event.preventDefault();
      onToggleThinkingLatestOnly();
    },
    [onToggleThinkingLatestOnly],
  );

  const handleTouchStart = useCallback(() => {
    if (!onToggleThinkingLatestOnly) return;
    clearLongPress();
    suppressTouchClickRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      suppressTouchClickRef.current = true;
      longPressTimerRef.current = null;
      onToggleThinkingLatestOnly();
    }, 450);
  }, [clearLongPress, onToggleThinkingLatestOnly]);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLButtonElement>) => {
      if (suppressTouchClickRef.current) {
        event.preventDefault();
      }
      clearLongPress();
    },
    [clearLongPress],
  );

  const handleToggleClick = useCallback(() => {
    if (suppressTouchClickRef.current) {
      suppressTouchClickRef.current = false;
      return;
    }
    onToggleThinkingItemsVisible?.();
  }, [onToggleThinkingItemsVisible]);

  const toggleAnimationPaused = useCallback(() => {
    setIsAnimationPaused((paused) => !paused);
  }, []);

  const handleAnimationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleAnimationPaused();
    },
    [toggleAnimationPaused],
  );

  // Check setting and shuffle phrases when processing starts
  const phrases = useMemo(() => {
    if (!isProcessing) return ["Thinking..."];
    const funEnabled = getFunPhrasesEnabled();
    if (!funEnabled) return ["Thinking..."];
    return shuffle(PROCESSING_PHRASES);
  }, [isProcessing]);

  // Rotate phrases
  useEffect(() => {
    if (!isProcessing) {
      setPhraseIndex(0);
      setDisplayedText("");
      setIsTyping(true);
      setIsAnimationPaused(false);
      return;
    }

    if (isAnimationPaused) return;

    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length);
      setIsTyping(true);
      setDisplayedText("");
    }, ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isProcessing, isAnimationPaused, phrases.length]);

  // Typewriter effect
  useEffect(() => {
    if (!isProcessing || !isTyping || isAnimationPaused) return;

    const phrase = phrases[phraseIndex] ?? "";
    if (displayedText.length >= phrase.length) {
      setIsTyping(false);
      return;
    }

    const timeout = setTimeout(() => {
      setDisplayedText(phrase.slice(0, displayedText.length + 1));
    }, TYPEWRITER_SPEED_MS);

    return () => clearTimeout(timeout);
  }, [
    isProcessing,
    isTyping,
    isAnimationPaused,
    phraseIndex,
    displayedText,
    phrases,
  ]);

  if (!isProcessing && !showThinkingToggle) {
    return null;
  }

  const visibilityTitle = thinkingItemsVisible
    ? t("processingThinkingTranscriptHide")
    : hasThinkingItems
      ? t("processingThinkingTranscriptShowHidden")
      : t("processingThinkingTranscriptShowWhenAvailable");
  // Describe what right-click / long-press does from the current state.
  const modeHint = onToggleThinkingLatestOnly
    ? !thinkingItemsVisible
      ? t("processingThinkingRightClickShowExpandAll")
      : thinkingLatestOnly
        ? t("processingThinkingRightClickExpandAll")
        : t("processingThinkingRightClickLatestOnly")
    : null;
  const thinkingToggleTitle = modeHint
    ? `${visibilityTitle}\n${modeHint}`
    : visibilityTitle;
  const animationToggleLabel = isAnimationPaused
    ? t("processingAnimationResume")
    : t("processingAnimationPause");

  return (
    <div
      className={`processing-indicator ${
        !isProcessing ? "processing-indicator--control-only" : ""
      } ${!thinkingItemsVisible && hasThinkingItems ? "processing-indicator--thinking-hidden" : ""}`}
    >
      {showThinkingToggle && (
        <button
          type="button"
          className={`processing-thinking-toggle ${
            thinkingItemsVisible ? "is-visible" : "is-muted"
          } ${thinkingLatestOnly ? "is-latest-only" : ""}`.trim()}
          onClick={handleToggleClick}
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={clearLongPress}
          onTouchMove={clearLongPress}
          aria-pressed={thinkingItemsVisible}
          aria-label={visibilityTitle}
          title={thinkingToggleTitle}
        >
          <ThoughtTranscriptIcon muted={!thinkingItemsVisible} />
        </button>
      )}
      {isProcessing && (
        <>
          <div className="processing-dot-container">
            <ThinkingIndicator />
          </div>
          <span
            className="processing-text"
            role="button"
            tabIndex={0}
            aria-pressed={isAnimationPaused}
            aria-label={animationToggleLabel}
            title={animationToggleLabel}
            onClick={toggleAnimationPaused}
            onKeyDown={handleAnimationKeyDown}
          >
            {displayedText}
            <span
              className="processing-cursor"
              style={
                isAnimationPaused ? { animationPlayState: "paused" } : undefined
              }
            >
              |
            </span>
          </span>
        </>
      )}
    </div>
  );
});
