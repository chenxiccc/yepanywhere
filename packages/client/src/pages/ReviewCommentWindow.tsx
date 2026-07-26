import { useState } from "react";

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * The in-place comment popover shared by the diff and blame comment surfaces
 * (topic: source-review-to-session). It renders the clicked line's anchor
 * label + snippet and offers "Add to review" (persist a pending draft) and
 * "Submit now" (drain that one comment into a fresh session). It is presentation
 * only — the caller supplies the anchor and owns the review-draft actions (see
 * `useReviewCommentDraft`).
 */
export function ReviewCommentWindow({
  anchorLabel,
  snippet,
  top,
  busy,
  error,
  onCancel,
  onAddToReview,
  onSubmitNow,
  t,
}: {
  anchorLabel: string;
  snippet: string;
  top: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAddToReview: (text: string) => void;
  onSubmitNow: (text: string) => void;
  t: TranslationFn;
}) {
  const [text, setText] = useState("");
  const canSubmit = text.trim().length > 0 && !busy;

  return (
    <div className="review-comment-window" style={{ top }}>
      <div className="review-comment-window-anchor">{anchorLabel}</div>
      <pre className="review-comment-window-snippet">{snippet}</pre>
      <textarea
        className="review-comment-window-input"
        // biome-ignore lint/a11y/noAutofocus: the window opens on an explicit click
        autoFocus
        rows={3}
        value={text}
        placeholder={t("sourceReviewCommentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <div className="review-comment-window-error">{error}</div>}
      <div className="review-comment-window-actions">
        <button
          type="button"
          className="review-comment-window-cancel"
          onClick={onCancel}
          disabled={busy}
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          className="review-comment-window-add"
          onClick={() => onAddToReview(text)}
          disabled={!canSubmit}
        >
          {t("sourceReviewAddToReview")}
        </button>
        <button
          type="button"
          className="review-comment-window-submit"
          onClick={() => onSubmitNow(text)}
          disabled={!canSubmit}
        >
          {t("sourceReviewSubmitNow")}
        </button>
      </div>
    </div>
  );
}
