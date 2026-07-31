import { useState } from "react";
import { SessionHoverCardTarget } from "../components/SessionHoverCardTarget";
import type { SourceReviewDefaultSession } from "../contexts/SourceReviewDefaultSessionContext";
import type { TranslationFn } from "../i18n";
import styles from "./ReviewCommentWindow.module.css";

/**
 * The in-place comment popover shared by the diff and blame comment surfaces
 * (topic: source-review-to-session). It renders the clicked line's anchor
 * label + snippet and offers "Add to review" (persist a pending draft) and
 * explicit default-session and new-session submit actions (drain that one
 * comment immediately). It is presentation only — the caller supplies the
 * anchor and owns the review-draft actions (see `useReviewCommentDraft`).
 */
export function ReviewCommentWindow({
  anchorLabel,
  snippet,
  top,
  busy,
  error,
  onCancel,
  onAddToReview,
  defaultSession,
  onSubmitToDefault,
  onSubmitToNew,
  t,
}: {
  anchorLabel: string;
  snippet: string;
  top: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAddToReview: (text: string) => void;
  defaultSession: SourceReviewDefaultSession | null;
  onSubmitToDefault: ((text: string) => void) | null;
  onSubmitToNew: (text: string) => void;
  t: TranslationFn;
}) {
  const [text, setText] = useState("");
  const canSubmit = text.trim().length > 0 && !busy;

  return (
    <div className={styles.window} style={{ top }}>
      <div className={styles.anchor}>{anchorLabel}</div>
      <pre className={styles.snippet}>{snippet}</pre>
      <textarea
        className={styles.input}
        // biome-ignore lint/a11y/noAutofocus: the window opens on an explicit click
        autoFocus
        rows={3}
        value={text}
        placeholder={t("sourceReviewCommentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.actions}>
        {/* review-comment-window-cancel and -add stay literal: no stylesheet
            declares them, so they are DOM hooks this module does not own. */}
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
        <div className={styles.submitActions}>
          {defaultSession && onSubmitToDefault && (
            <SessionHoverCardTarget
              sessionId={defaultSession.id}
              fallback={{
                projectId: defaultSession.projectId,
                title: defaultSession.title,
                provider: defaultSession.newSession.provider,
                model: defaultSession.newSession.model,
              }}
              className={styles.defaultSessionTarget}
            >
              <button
                type="button"
                className={styles.submit}
                onClick={() => onSubmitToDefault(text)}
                disabled={!canSubmit}
              >
                {t("sourceReviewSubmitToDefault")}
              </button>
            </SessionHoverCardTarget>
          )}
          <button
            type="button"
            className={styles.submit}
            onClick={() => onSubmitToNew(text)}
            disabled={!canSubmit}
          >
            {t("sourceReviewSubmitToNew")}
          </button>
        </div>
      </div>
    </div>
  );
}
