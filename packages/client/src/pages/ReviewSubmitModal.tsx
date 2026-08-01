import type {
  ProviderName,
  ReviewNewSessionOptions,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { GlobalSessionItem } from "../api/client";
import type { ReviewPreviewItem } from "../api/reviewClient";
import { Modal } from "../components/ui/Modal";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";
import { loadProjectSessions, reviewSessionLabel } from "../lib/reviewSessions";
import type { TranslationFn } from "../i18n";

/**
 * The accumulating-review submit flow (topic: source-review-to-session, phase
 * P7). "Submit review" opens this: it previews every pending comment
 * (relocated against the current tree), lists stale ones first pre-selected
 * for discard, lets the reviewer pick the survivors and a target session
 * (the recent review session by default, else a fresh one), and drains the
 * chosen comments into one review turn.
 */

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
  const [targetSessionId, setTargetSessionId] = useState(
    recentReviewSessionId ?? "new",
  );
  const targetTouchedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [sessions, setSessions] = useState<GlobalSessionItem[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const { providers, loading: providersLoading } = useProviders();
  const availableProviders = useMemo(
    () => getAvailableProviders(providers),
    [providers],
  );
  const [providerName, setProviderName] = useState<ProviderName | "">("");
  const [model, setModel] = useState("");
  const selectedProvider = availableProviders.find(
    (provider) => provider.name === providerName,
  );

  useEffect(() => {
    const preferred = getDefaultProvider(providers);
    if (preferred) setProviderName((current) => current || preferred.name);
  }, [providers]);

  // Load the project's sessions so a review can target any of them, not just a
  // fresh one or the recent review session.
  useEffect(() => {
    let cancelled = false;
    loadProjectSessions(projectId)
      .then((result) => {
        if (cancelled) return;
        setSessions(result);
        if (!targetTouchedRef.current) {
          setTargetSessionId(
            recentReviewSessionId
              ? recentReviewSessionId
              : (result[0]?.id ?? "new"),
          );
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setSessionsError(
          cause instanceof Error
            ? cause.message
            : t("sourceReviewSessionsUnavailable"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, recentReviewSessionId, t]);

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
      const newSession: ReviewNewSessionOptions | undefined =
        targetSessionId === "new"
          ? {
              provider: providerName || undefined,
              model: model || undefined,
            }
          : undefined;
      const result = await api.submitReview(
        projectId,
        include,
        targetSessionId,
        newSession,
      );
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
    targetSessionId,
    providerName,
    model,
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
          <div className="review-submit-destination">
            <label className="review-submit-field">
              <span>{t("sourceReviewTargetLegend")}</span>
              <select
                className="review-submit-session-select"
                value={targetSessionId}
                onChange={(event) => {
                  targetTouchedRef.current = true;
                  setTargetSessionId(event.target.value);
                }}
              >
                <option value="new">{t("sourceReviewTargetNew")}</option>
                {recentReviewSessionId &&
                  !sessions?.some(
                    (session) => session.id === recentReviewSessionId,
                  ) && (
                    <option value={recentReviewSessionId}>
                      {t("sourceReviewTargetRecent")} ·{" "}
                      {recentReviewSessionId.slice(0, 8)}
                    </option>
                  )}
                {sessions?.map((session) => (
                  <option key={session.id} value={session.id}>
                    {reviewSessionLabel(
                      session,
                      session.id === recentReviewSessionId
                        ? t("sourceReviewRecentSuffix")
                        : undefined,
                    )}
                  </option>
                ))}
              </select>
            </label>

            {sessionsError && (
              <div className="review-submit-target-error">
                {t("sourceReviewSessionsUnavailable")}: {sessionsError}
              </div>
            )}

            {targetSessionId === "new" && (
              <div className="review-submit-new-session">
                <label className="review-submit-field">
                  <span>{t("sourceReviewProvider")}</span>
                  <select
                    value={providerName}
                    disabled={
                      providersLoading || availableProviders.length === 0
                    }
                    onChange={(event) => {
                      setProviderName(event.target.value as ProviderName);
                      setModel("");
                    }}
                  >
                    {availableProviders.map((provider) => (
                      <option key={provider.name} value={provider.name}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="review-submit-field">
                  <span>{t("sourceReviewModel")}</span>
                  <select
                    value={model}
                    disabled={!selectedProvider}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="">{t("sourceReviewModelDefault")}</option>
                    {selectedProvider?.models?.map((providerModel) => (
                      <option key={providerModel.id} value={providerModel.id}>
                        {providerModel.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
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
