import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tracks the short browser-local window in which a manual composer delivery
 * still belongs to freshly finalized speech. The ref-backed query is
 * synchronous so a delivery event does not depend on a timer render landing.
 */
export function useRecentSpeechAttribution(windowMs: number) {
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);

  const clear = useCallback(() => {
    deadlineRef.current = 0;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setActive(false);
  }, []);

  const noteSpeech = useCallback(() => {
    if (windowMs <= 0) {
      clear();
      return;
    }
    deadlineRef.current = Date.now() + windowMs;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      deadlineRef.current = 0;
      setActive(false);
    }, windowMs);
    setActive(true);
  }, [clear, windowMs]);

  const isRecent = useCallback(() => {
    const recent = deadlineRef.current > Date.now();
    if (!recent && deadlineRef.current !== 0) clear();
    return recent;
  }, [clear]);

  useEffect(() => {
    if (windowMs <= 0) clear();
  }, [clear, windowMs]);

  useEffect(
    () => () => {
      deadlineRef.current = 0;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return {
    active,
    noteSpeech,
    isRecent,
    consume: clear,
  };
}
