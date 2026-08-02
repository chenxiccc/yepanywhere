import {
  deriveReviewSubmissionName,
  type ReviewCapturedSource,
  type ReviewSite,
  type ReviewSubmissionDetail,
  type ReviewSubmissionSummary,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { TranslationFn } from "../i18n";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";
import styles from "./ReviewSubmissionsPanel.module.css";

/** Canonical submission/site browser for captured source-review history. */
export function ReviewSubmissionsPanel({
  projectId,
  sessionHref,
  t,
}: {
  projectId: string;
  sessionHref: (sessionId: string) => string;
  t: TranslationFn;
}) {
  const [submissions, setSubmissions] = useState<ReviewSubmissionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewSubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSubmissions = useCallback(
    async (cursor?: string) => {
      const result = await api.listReviewSubmissions(projectId, {
        cursor,
        limit: 50,
      });
      setSubmissions((current) =>
        cursor ? [...current, ...result.submissions] : result.submissions,
      );
      setNextCursor(result.nextCursor);
      if (!cursor) {
        setSelectedId((current) =>
          result.submissions.some((item) => item.id === current)
            ? current
            : (result.submissions[0]?.id ?? null),
        );
      }
    },
    [projectId],
  );

  const loadDetail = useCallback(
    async (submissionId: string) => {
      const result = await api.getReviewSubmission(projectId, submissionId);
      setDetail(result);
      if (
        result.submission.responseRevision >
        result.submission.acknowledgedRevision
      ) {
        void api
          .acknowledgeReviewSubmission(projectId, submissionId)
          .then(({ submission }) => {
            setSubmissions((current) =>
              current.map((item) =>
                item.id === submission.id ? submission : item,
              ),
            );
            setDetail((current) =>
              current?.submission.id === submission.id
                ? { ...current, submission }
                : current,
            );
          });
      }
    },
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadSubmissions()
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("sourceReviewSubmissionsLoadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSubmissions, t]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    loadDetail(selectedId).catch((cause: unknown) => {
      if (!cancelled) {
        setError(
          cause instanceof Error
            ? cause.message
            : t("sourceReviewSubmissionLoadFailed"),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, selectedId, t]);

  const refresh = useCallback(async () => {
    await loadSubmissions();
    if (selectedId) await loadDetail(selectedId);
  }, [loadDetail, loadSubmissions, selectedId]);

  if (loading)
    return <section className={styles.empty}>{t("loading")}</section>;
  if (submissions.length === 0) {
    return (
      <section className={styles.empty}>
        {t("sourceReviewNoSubmissions")}
      </section>
    );
  }

  const selected =
    submissions.find((submission) => submission.id === selectedId) ??
    submissions[0]!;

  return (
    <section className={styles.panel}>
      <ul className={styles.submissionList}>
        {submissions.map((submission) => (
          <li key={submission.id}>
            <button
              type="button"
              className={`${styles.submissionButton} ${
                submission.id === selected.id ? styles.active : ""
              }`.trimEnd()}
              onClick={() => setSelectedId(submission.id)}
            >
              <span>{submissionLabel(submission, t)}</span>
              {submission.responseRevision >
                submission.acknowledgedRevision && (
                <span
                  className={styles.unread}
                  role="img"
                  aria-label={t("sourceReviewUnread")}
                />
              )}
            </button>
          </li>
        ))}
        {nextCursor && (
          <li>
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => void loadSubmissions(nextCursor)}
            >
              {t("sourceReviewLoadOlder")}
            </button>
          </li>
        )}
      </ul>

      <label className={styles.mobileSelector}>
        <span>{t("sourceReviewSelectSubmission")}</span>
        <select
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {submissions.map((submission) => (
            <option key={submission.id} value={submission.id}>
              {submissionLabel(submission, t)}
            </option>
          ))}
        </select>
      </label>

      <article className={styles.detail}>
        {error && <div className={styles.error}>{error}</div>}
        {detail?.submission.id === selected.id ? (
          <SubmissionDetail
            detail={detail}
            projectId={projectId}
            sessionHref={sessionHref}
            refresh={refresh}
            t={t}
          />
        ) : (
          <div className={styles.empty}>{t("loading")}</div>
        )}
      </article>
    </section>
  );
}

function SubmissionDetail({
  detail,
  projectId,
  sessionHref,
  refresh,
  t,
}: {
  detail: ReviewSubmissionDetail;
  projectId: string;
  sessionHref: (sessionId: string) => string;
  refresh: () => Promise<void>;
  t: TranslationFn;
}) {
  const sourceByEntry = useMemo(
    () =>
      new Map(
        detail.capturedSources.map(({ siteId, entryId, source }) => [
          `${siteId}\0${entryId}`,
          source,
        ]),
      ),
    [detail.capturedSources],
  );
  const firstEntry = detail.sites
    .flatMap((site) => site.entries)
    .find((entry) => entry.submissionId === detail.submission.id);
  const title =
    detail.submission.name ??
    deriveReviewSubmissionName(firstEntry?.text ?? "");

  return (
    <>
      <header className={styles.detailHeader}>
        <div>
          <h2>{title}</h2>
          <div className={styles.submittedAt}>
            {submissionDate(detail.submission)}
          </div>
        </div>
        {detail.submission.targetSessionId ? (
          <Link
            className={styles.sessionLink}
            to={sessionHref(detail.submission.targetSessionId)}
          >
            {t("sourceReviewOpenSession")}
          </Link>
        ) : (
          <span className={styles.awaitingSession}>
            {t("sourceReviewAwaitingSession")}
          </span>
        )}
      </header>
      <ul className={styles.siteList}>
        {detail.sites.map((site) => (
          <ReviewSiteCard
            key={site.id}
            site={site}
            sourceFor={(entryId) =>
              sourceByEntry.get(`${site.id}\0${entryId}`) ?? {
                status: "legacy-missing",
              }
            }
            projectId={projectId}
            refresh={refresh}
            sessionHref={sessionHref}
            t={t}
          />
        ))}
      </ul>
    </>
  );
}

function ReviewSiteCard({
  site,
  sourceFor,
  projectId,
  refresh,
  sessionHref,
  t,
}: {
  site: ReviewSite;
  sourceFor: (entryId: string) => ReviewCapturedSource;
  projectId: string;
  refresh: () => Promise<void>;
  sessionHref: (sessionId: string) => string;
  t: TranslationFn;
}) {
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = site.entries.at(-1);
  const hasPending = latest?.submittedAt === undefined;
  const state = siteState(site);

  const addFollowUp = async () => {
    const text = followUp.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.addReviewFollowUp(projectId, site.id, text);
      setFollowUp("");
      notifyReviewCommentsChanged(projectId);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("sourceReviewFollowUpFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resolveReviewSite(projectId, site.id);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("sourceReviewResolveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.site}>
      <header className={styles.siteHeader}>
        <span className={styles.location}>{site.path}</span>
        <span className={`${styles.state} ${siteStateClass(state)}`}>
          {siteStateLabel(state, t)}
        </span>
      </header>
      <ol className={styles.entryList}>
        {site.entries.map((entry) => {
          const outcomes = site.outcomes.filter(
            (outcome) => outcome.entryId === entry.id,
          );
          return (
            <li key={entry.id} className={styles.entry}>
              <div className={styles.entryHead}>
                <span>{commentLocation(entry.anchor)}</span>
                <span>
                  {entry.submittedAt
                    ? t("sourceReviewSubmittedEntry")
                    : t("sourceReviewPendingFollowUp")}
                </span>
              </div>
              <div className={styles.text}>{entry.text}</div>
              <CapturedSource source={sourceFor(entry.id)} t={t} />
              {outcomes.map((outcome) => (
                <div key={outcome.responseHash} className={styles.outcome}>
                  <div className={styles.outcomeHead}>
                    <span>{dispositionLabel(outcome.disposition, t)}</span>
                    {outcome.sessionId && (
                      <Link to={sessionHref(outcome.sessionId)}>
                        {t("sourceReviewOutcomeSession")}
                      </Link>
                    )}
                  </div>
                  <div>{outcome.text}</div>
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {error && <div className={styles.error}>{error}</div>}
      {!hasPending && (
        <div className={styles.followUp}>
          <textarea
            aria-label={t("sourceReviewFollowUp")}
            value={followUp}
            maxLength={20_000}
            placeholder={t("sourceReviewFollowUpPlaceholder")}
            onChange={(event) => setFollowUp(event.target.value)}
          />
          <div className={styles.siteActions}>
            {!site.resolvedAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve()}
              >
                {t("sourceReviewResolve")}
              </button>
            )}
            <button
              type="button"
              disabled={busy || !followUp.trim()}
              onClick={() => void addFollowUp()}
            >
              {t("sourceReviewAddFollowUp")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CapturedSource({
  source,
  t,
}: {
  source: ReviewCapturedSource;
  t: TranslationFn;
}) {
  if (source.status === "legacy-missing") {
    return (
      <div className={styles.captureMissing}>
        {t("sourceReviewLegacyCaptureMissing")}
      </div>
    );
  }
  if (source.status === "unavailable") {
    return (
      <div className={styles.captureMissing}>
        {captureUnavailableLabel(source.reason, t)}
      </div>
    );
  }
  return (
    <div className={styles.source}>
      <div className={styles.captureId}>
        {t("sourceReviewCapturedSource")} · {source.captureBlobId.slice(0, 12)}
      </div>
      <pre>
        {source.content.split("\n").map((line, index) => {
          const lineNumber = source.startLine + index;
          return (
            <span
              key={lineNumber}
              className={
                lineNumber === source.highlightLine ? styles.highlight : ""
              }
            >
              <span className={styles.lineNumber}>{lineNumber}</span>
              <span>{line || " "}</span>
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function siteState(site: ReviewSite): "open" | "addressed" | "resolved" {
  if (site.resolvedAt) return "resolved";
  const latestSubmitted = [...site.entries]
    .reverse()
    .find((entry) => entry.submittedAt);
  return latestSubmitted &&
    site.outcomes.some((outcome) => outcome.entryId === latestSubmitted.id)
    ? "addressed"
    : "open";
}

function submissionLabel(
  submission: ReviewSubmissionSummary,
  t: TranslationFn,
): string {
  return (
    submission.name ??
    t("sourceReviewSubmission", { date: submissionDate(submission) })
  );
}

function submissionDate(submission: ReviewSubmissionSummary): string {
  const timestamp = new Date(submission.submittedAt);
  return Number.isNaN(timestamp.getTime())
    ? submission.submittedAt
    : timestamp.toLocaleString();
}

function commentLocation(
  anchor: ReviewSite["entries"][number]["anchor"],
): string {
  const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
  const oldSide = anchor.side === "old" ? " (old)" : "";
  return `${anchor.path}:${line ?? "?"}${oldSide}`;
}

function dispositionLabel(
  disposition: ReviewSite["outcomes"][number]["disposition"],
  t: TranslationFn,
): string {
  if (disposition === "wont_fix") return t("sourceReviewOutcomeWontFix");
  if (disposition === "question") return t("sourceReviewOutcomeQuestion");
  return t("sourceReviewOutcomeDone");
}

function siteStateLabel(
  state: "open" | "addressed" | "resolved",
  t: TranslationFn,
): string {
  if (state === "addressed") return t("sourceReviewStateAddressed");
  if (state === "resolved") return t("sourceReviewStateResolved");
  return t("sourceReviewStateOpen");
}

function siteStateClass(state: "open" | "addressed" | "resolved"): string {
  if (state === "addressed") return styles.addressed!;
  if (state === "resolved") return styles.resolved!;
  return styles.open!;
}

function captureUnavailableLabel(
  reason: "binary" | "too-large" | "missing",
  t: TranslationFn,
): string {
  if (reason === "binary") return t("sourceReviewCaptureUnavailableBinary");
  if (reason === "too-large") {
    return t("sourceReviewCaptureUnavailableTooLarge");
  }
  return t("sourceReviewCaptureUnavailableMissing");
}
