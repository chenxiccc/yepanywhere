const SESSION_FILE_COMMENT_DRAFT_PREFIX = "session-file-comments";
export const SESSION_FILE_COMMENT_MODE_ATTR = "data-session-file-comment-mode";
const MAX_DRAFTS = 100;
const MAX_TEXT_LENGTH = 20_000;
const MAX_QUOTE_LENGTH = 8_000;

export interface SessionFileCommentAnchor {
  location: string;
  quote: string;
  /** Source line after which an editor can split a source view. */
  afterLine?: number;
  /** Rendered top-level block after which an editor can split Markdown. */
  afterBlock?: number;
  /** Keep the browser selection active until the user enters the editor. */
  preserveSelection?: boolean;
}

export interface SessionFileCommentDraft extends SessionFileCommentAnchor {
  id: string;
  text: string;
}

export function sessionFileCommentDraftKey({
  sourceKey,
  sessionId,
  projectId,
  filePath,
}: {
  sourceKey: string;
  sessionId: string;
  projectId: string;
  filePath: string;
}): string {
  return [
    SESSION_FILE_COMMENT_DRAFT_PREFIX,
    sourceKey,
    sessionId,
    projectId,
    filePath,
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function loadSessionFileCommentDrafts(
  key: string,
): SessionFileCommentDraft[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!Array.isArray(parsed)) return [];
    const drafts: SessionFileCommentDraft[] = [];
    for (const value of parsed.slice(0, MAX_DRAFTS)) {
      if (!isRecord(value)) continue;
      const { id, location, quote, text, afterLine, afterBlock } = value;
      if (
        typeof id !== "string" ||
        !id ||
        typeof location !== "string" ||
        !location ||
        typeof quote !== "string" ||
        !quote.trim() ||
        typeof text !== "string" ||
        !text.trim() ||
        location.length > MAX_QUOTE_LENGTH ||
        quote.length > MAX_QUOTE_LENGTH ||
        text.length > MAX_TEXT_LENGTH ||
        (afterLine !== undefined &&
          (!Number.isInteger(afterLine) || Number(afterLine) < 1)) ||
        (afterBlock !== undefined &&
          (!Number.isInteger(afterBlock) || Number(afterBlock) < 0))
      ) {
        continue;
      }
      drafts.push({
        id,
        location,
        quote,
        text,
        ...(afterLine === undefined ? {} : { afterLine: Number(afterLine) }),
        ...(afterBlock === undefined ? {} : { afterBlock: Number(afterBlock) }),
      });
    }
    return drafts;
  } catch {
    return [];
  }
}

export function saveSessionFileCommentDrafts(
  key: string,
  drafts: readonly SessionFileCommentDraft[],
): void {
  const nonempty = drafts
    .filter((draft) => draft.text.trim())
    .slice(0, MAX_DRAFTS);
  if (nonempty.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(nonempty));
}

export function formatSessionFileComment(
  draft: SessionFileCommentDraft,
): string {
  const quote = draft.quote
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${draft.location}\n\n${quote}\n\n${draft.text.trim()}`;
}

export function formatSessionFileCommentBatch(
  drafts: readonly SessionFileCommentDraft[],
): string {
  return drafts.map(formatSessionFileComment).join("\n\n---\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
