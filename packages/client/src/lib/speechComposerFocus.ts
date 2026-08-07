import { hasCoarsePointer } from "./deviceDetection";

/**
 * Keep speech as an independent input path on touch-first devices, where
 * focusing the composer would summon the on-screen keyboard. Fine-pointer and
 * keyboard workflows retain their ready-to-type focus behavior.
 */
export function focusComposerForSpeechTransition(
  textarea: HTMLTextAreaElement | null,
): void {
  if (!hasCoarsePointer()) textarea?.focus();
}
