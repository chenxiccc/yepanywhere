import type { ContentBlock, Message } from "../types";
import { isPlainUserTurn } from "./linearMessageDedup";
import { getMessageContent, getMessageId } from "./mergeMessages";
import {
  getPromptTextForCorrection,
  getSearchPreviewFallback,
} from "./sessionDetail/search";

/**
 * One recallable prior user turn for the composer recall drawer.
 * See topics/composer-recall-drawer.md.
 */
export interface ComposerTurnRecallEntry {
  /**
   * Render id of the source user-turn message (`getMessageId` = uuid ?? id).
   * This is exactly the `data-render-id` of the transcript row and the `id`
   * that `getUserTurnNavAnchors` / `scrollToRenderId` / `findRenderRow` use,
   * so the go-to-turn control can scroll to this turn. See
   * topics/composer-recall-drawer.md.
   */
  id: string;
  /** Full prompt text, drafted verbatim into the composer on Enter. */
  text: string;
  /** Single-line, whitespace-collapsed, ~180-char preview for the menu row. */
  preview: string;
}

function extractUserTurnText(message: Message): string {
  const content = getMessageContent(message);
  if (typeof content !== "string" && !Array.isArray(content)) {
    return "";
  }
  return getPromptTextForCorrection(content as string | ContentBlock[]);
}

/**
 * Prior user-turn recall entries derived from the live session messages:
 * user turns only, full prompt text extracted, empties dropped, deduplicated
 * by text, newest-first. Pure. See topics/composer-recall-drawer.md.
 */
export function getComposerTurnRecallEntries(
  messages: readonly Message[],
): ComposerTurnRecallEntry[] {
  const entries: ComposerTurnRecallEntry[] = [];
  const seen = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isPlainUserTurn(message)) {
      continue;
    }
    const text = extractUserTurnText(message);
    if (!text.trim() || seen.has(text)) {
      continue;
    }
    seen.add(text);
    // Newest-first + dedup-by-text means the retained entry is the most recent
    // occurrence, so its id points at the latest rendered row for that text.
    entries.push({
      id: getMessageId(message),
      text,
      preview: getSearchPreviewFallback(text),
    });
  }
  return entries;
}

/**
 * Entries whose text prefix-matches the current draft (case-insensitive,
 * trimmed). Empty draft returns every entry. Newest-first order is preserved.
 */
export function filterComposerTurnRecall(
  entries: readonly ComposerTurnRecallEntry[],
  draft: string,
): ComposerTurnRecallEntry[] {
  const needle = draft.trim().toLowerCase();
  if (!needle) {
    return entries.slice();
  }
  return entries.filter((entry) =>
    entry.text.trim().toLowerCase().startsWith(needle),
  );
}
