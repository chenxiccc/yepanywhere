import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { ReviewPreviewItem } from "../api/reviewClient";
import { Modal } from "../components/ui/Modal";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";

/**
 * The accumulating-review submit flow (topic: source-review-to-session, phase
 * P7). "Submit review" opens this: it previews every pending comment
 * (relocated against the current tree), lists stale ones first pre-selected
 * for discard, lets the reviewer pick the survivors and a target session
 * (the recent review session by default, else a fresh one), and drains the
 * chosen comments into one review turn.
 */

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

type Target = "new" | "recent";

export function ReviewSubmitModal({
  projectId,
  recentReviewSessionId,
  onClose,
  onNavigateSession,
  t,
}: {
  projectId: string;
  recentReviewSessionId: string | null;
  onClose: () => void;
  onNavigateSession: (sessionId: string) => void;
  t: TranslationFn;
}) {
  const [items, setItems] = useState<ReviewPreviewItem[] | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Target>(
    recentReviewSessionId ? "recent" : "new",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewReview(projectId)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        // Default: include everything the server did not flag for discard.
        setIncluded(
          new Set(
            result.items
              .filter((item) => !item.defaultDiscard)
              .map((item) => item.comment.id),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to preview");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggle = useCallback((id: string) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    const include = [...included];
    if (include.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const targetValue =
        target === "recent" && recentReviewSessionId
          ? recentReviewSessionId
          : "new";
      const result = await api.submitReview(projectId, include, targetValue);
      notifyReviewCommentsChanged(projectId);
      if (result.sessionId) {
        onNavigateSession(result.sessionId);
        onClose();
        return;
      }
      setNotice(t("sourceReviewSubmitQueued"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setBusy(false);
    }
  }, [
    included,
    target,
    recentReviewSessionId,
    projectId,
    onNavigateSession,
    onClose,
    t,
  ]);

  return (
    <Modal title={t("sourceReviewSubmitTitle")} onClose={onClose}>
      <div className="review-submit-modal">
        {error && <div className="review-submit-error">{error}</div>}
        {notice && <div className="review-submit-notice">{notice}</div>}
        {items === null ? (
          <div className="review-submit-loading">{t("loading")}</div>
        ) : items.length === 0 ? (
          <div className="review-submit-empty">
            {t("sourceReviewNoPending")}
          </div>
        ) : (
          <ul className="review-submit-list">
            {items.map((item) => (
              <ReviewPreviewRow
                key={item.comment.id}
                item={item}
                checked={included.has(item.comment.id)}
                onToggle={() => toggle(item.comment.id)}
                t={t}
              />
            ))}
          </ul>
        )}

        {items && items.length > 0 && (
          <fieldset className="review-submit-target">
            <legend>{t("sourceReviewTargetLegend")}</legend>
            {recentReviewSessionId && (
              <label>
                <input
                  type="radio"
                  name="review-target"
                  checked={target === "recent"}
                  onChange={() => setTarget("recent")}
                />
                {t("sourceReviewTargetRecent")}
              </label>
            )}
            <label>
              <input
                type="radio"
                name="review-target"
                checked={target === "new"}
                onChange={() => setTarget("new")}
              />
              {t("sourceReviewTargetNew")}
            </label>
          </fieldset>
        )}

        <div className="review-submit-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="review-submit-go"
            onClick={submit}
            disabled={busy || included.size === 0}
          >
            {t("sourceReviewSubmitReview", { count: included.size })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ReviewPreviewRow({
  item,
  checked,
  onToggle,
  t,
}: {
  item: ReviewPreviewItem;
  checked: boolean;
  onToggle: () => void;
  t: TranslationFn;
}) {
  const gone = item.relocation.status === "gone";
  const location = gone
    ? item.relocation.citeSha
      ? `${item.relocation.path} @ ${item.relocation.citeSha.slice(0, 8)}`
      : item.relocation.path
    : `${item.relocation.path}:${item.relocation.line}`;

  return (
    <li className={`review-submit-row ${gone ? "is-stale" : ""}`}>
      <label className="review-submit-row-head">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="review-submit-row-loc">{location}</span>
        {gone && (
          <span className="review-submit-row-stale">
            {t("sourceReviewStale")}
          </span>
        )}
        {!gone && item.relocation.moved && (
          <span className="review-submit-row-moved">
            {t("sourceReviewMoved")}
          </span>
        )}
      </label>
      <div className="review-submit-row-text">{item.comment.text}</div>
    </li>
  );
}
