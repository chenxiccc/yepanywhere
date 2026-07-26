import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { GlobalSessionItem } from "../api/client";
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

type Target = "new" | "recent" | "other";

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
  const [queued, setQueued] = useState(false);
  const [sessions, setSessions] = useState<GlobalSessionItem[] | null>(null);
  const [otherSessionId, setOtherSessionId] = useState("");

  // Load the project's sessions so a review can target any of them, not just a
  // fresh one or the recent review session.
  useEffect(() => {
    let cancelled = false;
    api
      .getGlobalSessions({ project: projectId, limit: 50 })
      .then((result) => {
        if (cancelled) return;
        setSessions(result.sessions);
        const first = result.sessions[0];
        if (first) setOtherSessionId((prev) => prev || first.id);
      })
      .catch(() => {
        // The arbitrary-session picker is optional; on failure it stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
          : target === "other" && otherSessionId
            ? otherSessionId
            : "new";
      const result = await api.submitReview(projectId, include, targetValue);
      notifyReviewCommentsChanged(projectId);
      if (result.sessionId) {
        onNavigateSession(result.sessionId);
        onClose();
        return;
      }
      // Queued (202): the comments are still pending. Lock this modal's submit
      // so an accidental re-click can't fire a second launch of the same batch
      // (the reviewer closes and retries deliberately when the queue frees).
      setNotice(t("sourceReviewSubmitQueued"));
      setQueued(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setBusy(false);
    }
  }, [
    included,
    target,
    recentReviewSessionId,
    otherSessionId,
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
            {sessions && sessions.length > 0 && (
              <label className="review-submit-target-other">
                <input
                  type="radio"
                  name="review-target"
                  checked={target === "other"}
                  onChange={() => setTarget("other")}
                />
                {t("sourceReviewTargetOther")}
                <select
                  className="review-submit-session-select"
                  value={otherSessionId}
                  disabled={target !== "other"}
                  onChange={(event) => {
                    setOtherSessionId(event.target.value);
                    setTarget("other");
                  }}
                >
                  {sessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {sessionLabel(session)}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
            disabled={busy || queued || included.size === 0}
          >
            {t("sourceReviewSubmitReview", { count: included.size })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function sessionLabel(session: GlobalSessionItem): string {
  return session.customTitle || session.title || session.id.slice(0, 8);
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
