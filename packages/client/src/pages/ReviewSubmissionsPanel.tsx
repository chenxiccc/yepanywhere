import type { ReviewBatch, ReviewComment } from "@yep-anywhere/shared";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { TranslationFn } from "../i18n";
import styles from "./ReviewSubmissionsPanel.module.css";

/** Read-only browser for submitted version-1 review batches. */
export function ReviewSubmissionsPanel({
  batches,
  archived,
  sessionHref,
  t,
}: {
  batches: ReviewBatch[];
  archived: ReviewComment[];
  sessionHref: (sessionId: string) => string;
  t: TranslationFn;
}) {
  const orderedBatches = useMemo(
    () =>
      [...batches].sort((left, right) =>
        right.submittedAt.localeCompare(left.submittedAt),
      ),
    [batches],
  );
  const commentsById = useMemo(
    () => new Map(archived.map((comment) => [comment.id, comment])),
    [archived],
  );
  const [selectedId, setSelectedId] = useState(orderedBatches[0]?.id ?? null);

  useEffect(() => {
    if (!orderedBatches.some((batch) => batch.id === selectedId)) {
      setSelectedId(orderedBatches[0]?.id ?? null);
    }
  }, [orderedBatches, selectedId]);

  if (orderedBatches.length === 0) {
    return (
      <section className={styles.empty}>
        {t("sourceReviewNoSubmissions")}
      </section>
    );
  }

  const selected =
    orderedBatches.find((batch) => batch.id === selectedId) ??
    orderedBatches[0]!;
  const selectedComments = selected.commentIds.flatMap((id) => {
    const comment = commentsById.get(id);
    return comment ? [comment] : [];
  });

  return (
    <section className={styles.panel}>
      <ul className={styles.submissionList}>
        {orderedBatches.map((batch) => (
          <li key={batch.id}>
            <button
              type="button"
              className={`${styles.submissionButton} ${
                batch.id === selected.id ? styles.active : ""
              }`.trimEnd()}
              onClick={() => setSelectedId(batch.id)}
            >
              {submissionLabel(batch, t)}
            </button>
          </li>
        ))}
      </ul>

      <label className={styles.mobileSelector}>
        <span>{t("sourceReviewSelectSubmission")}</span>
        <select
          value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {orderedBatches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {submissionLabel(batch, t)}
            </option>
          ))}
        </select>
      </label>

      <article className={styles.detail}>
        <header className={styles.detailHeader}>
          <h2>{submissionLabel(selected, t)}</h2>
          <Link
            className={styles.sessionLink}
            to={sessionHref(selected.targetSessionId)}
          >
            {t("sourceReviewOpenSession")}
          </Link>
        </header>
        <ul className={styles.commentList}>
          {selectedComments.map((comment) => (
            <li key={comment.id} className={styles.comment}>
              <div className={styles.commentHead}>
                <span className={styles.location}>
                  {commentLocation(comment)}
                </span>
                <span>{revisionLabel(comment, t)}</span>
              </div>
              <div className={styles.text}>{comment.text}</div>
              {comment.anchor.snippet && (
                <pre className={styles.snippet}>{comment.anchor.snippet}</pre>
              )}
              <div className={styles.captureMissing}>
                {t("sourceReviewLegacyCaptureMissing")}
              </div>
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}

function submissionLabel(batch: ReviewBatch, t: TranslationFn): string {
  const timestamp = new Date(batch.submittedAt);
  const date = Number.isNaN(timestamp.getTime())
    ? batch.submittedAt
    : timestamp.toLocaleString();
  return t("sourceReviewSubmission", { date });
}

function commentLocation(comment: ReviewComment): string {
  const { anchor } = comment;
  const line = anchor.side === "old" ? anchor.oldLine : anchor.newLine;
  const oldSide = anchor.side === "old" ? " (old)" : "";
  return `${anchor.path}:${line ?? "?"}${oldSide}`;
}

function revisionLabel(comment: ReviewComment, t: TranslationFn): string {
  const { revision } = comment.anchor;
  return revision.kind === "sha"
    ? revision.sha.slice(0, 7)
    : t("sourceBlameNotCommitted");
}
