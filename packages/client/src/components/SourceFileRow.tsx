import type { ReviewSiteStateSummary } from "@yep-anywhere/shared";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import type { MessageKey, TranslationFn } from "../i18n";
import styles from "./SourceFileRow.module.css";

type SourceFileRowButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> & {
  path: string;
  children: ReactNode;
};

/**
 * The row button owns the complete path tooltip. This keeps native and themed
 * tooltips working even when the visible path child is ellipsized.
 */
export function SourceFileRowButton({
  path,
  children,
  ...buttonProps
}: SourceFileRowButtonProps) {
  const tooltipAttributes = useTextTooltipAttributes(path);

  return (
    <button {...buttonProps} {...tooltipAttributes}>
      {children}
    </button>
  );
}

export function SourceFilePath({
  children,
  query,
  className,
  ...spanProps
}: HTMLAttributes<HTMLSpanElement> & { query?: string }) {
  const text = typeof children === "string" ? children : null;
  const match = text ? findPathMatch(text, query) : null;
  const pathClassName = [
    styles.path,
    match ? styles.pathWithMatch : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (!text || !match) {
    return (
      <span
        {...spanProps}
        className={pathClassName}
        data-source-path={text ?? undefined}
      >
        {children}
      </span>
    );
  }

  return (
    <span {...spanProps} className={pathClassName} data-source-path={text}>
      {match.prefix && (
        <span className={styles.matchPrefix}>{match.prefix}</span>
      )}
      <mark className={styles.match}>{match.text}</mark>
      {match.suffix && (
        <span className={styles.matchSuffix}>{match.suffix}</span>
      )}
    </span>
  );
}

function findPathMatch(
  path: string,
  rawQuery: string | undefined,
): { prefix: string; text: string; suffix: string } | null {
  const query = rawQuery?.trim();
  if (!query) return null;
  const start = path.toLowerCase().indexOf(query.toLowerCase());
  if (start < 0) return null;
  const end = start + query.length;
  return {
    prefix: path.slice(0, start),
    text: path.slice(start, end),
    suffix: path.slice(end),
  };
}

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  M: "sourceFileStatusModified",
  A: "sourceFileStatusAdded",
  D: "sourceFileStatusDeleted",
  R: "sourceFileStatusRenamed",
  C: "sourceFileStatusCopied",
  T: "sourceFileStatusTypeChanged",
  U: "sourceFileStatusUnmerged",
  "?": "sourceFileStatusUntracked",
};

export function SourceFileStatusBadge({
  status,
  t,
}: {
  status: string;
  t: TranslationFn;
}) {
  const meaning = t(STATUS_LABEL_KEYS[status] ?? "sourceFileStatusChanged");
  const label = `${status} — ${meaning}`;
  const tooltipAttributes = useTextTooltipAttributes(label);

  return (
    <span
      className={`git-status-badge git-status-${status.toLowerCase()}`}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      {status}
    </span>
  );
}

/** Independent discussion/source axes for unresolved sites on this file. */
export function SourceReviewStateBadges({
  states,
  t,
}: {
  states: ReviewSiteStateSummary[];
  t: TranslationFn;
}) {
  if (states.length === 0) return null;
  const open = states.filter((state) => state.state === "open").length;
  const addressed = states.length - open;
  const changed = states.filter(
    (state) => state.changeStatus === "changed",
  ).length;
  const unchanged = states.filter(
    (state) => state.changeStatus === "unchanged",
  ).length;
  const unavailable = states.length - changed - unchanged;
  const discussion =
    open > 0
      ? {
          label: t("sourceReviewStateOpen"),
          count: open,
          className: styles.open!,
        }
      : {
          label: t("sourceReviewStateAddressed"),
          count: addressed,
          className: styles.addressed!,
        };
  const source =
    changed > 0
      ? {
          label: t("sourceReviewSourceChanged"),
          count: changed,
          className: styles.changed!,
        }
      : unchanged > 0
        ? {
            label: t("sourceReviewSourceUnchanged"),
            count: unchanged,
            className: styles.unchanged!,
          }
        : {
            label: t("sourceReviewSourceUnavailable"),
            count: unavailable,
            className: styles.unavailable!,
          };

  return (
    <span className={styles.reviewStates}>
      <ReviewStateBadge {...discussion} t={t} />
      <ReviewStateBadge {...source} t={t} />
    </span>
  );
}

function ReviewStateBadge({
  label,
  count,
  className,
  t,
}: {
  label: string;
  count: number;
  className: string;
  t: TranslationFn;
}) {
  const title = t("sourceReviewSiteStateCount", { state: label, count });
  const tooltipAttributes = useTextTooltipAttributes(title);
  return (
    <span
      className={`${styles.reviewState} ${className}`}
      {...tooltipAttributes}
    >
      {label} {count}
    </span>
  );
}
