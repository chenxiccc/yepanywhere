import {
  DEFAULT_SNIPPET_CONTEXT_RADIUS,
  type GitBlameLine,
  type GitBlameResult,
  type ReviewCommentAnchor,
} from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { ReviewCommentWindow } from "./ReviewCommentWindow";

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface OpenBlameComment {
  /** Index into `blame.lines` of the clicked line. */
  index: number;
  top: number;
}

/**
 * The all-files blame view (topic: source-review-to-session, stage 3): a file's
 * lines with their originating commit in a gutter, syntax-highlighted (server
 * `highlightFile`, reconstructed line-for-line from the blame content). Clicking
 * a line opens the same review comment window as the diff surface, anchoring to
 * the line's blame-origin sha (or `uncommitted` for a not-yet-committed line),
 * so a blame comment feeds the same review accumulator.
 */
export function BlameView({
  projectId,
  path,
  t,
}: {
  projectId: string;
  path: string;
  t: TranslationFn;
}) {
  const [blame, setBlame] = useState<GitBlameResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenBlameComment | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    pending,
    busy,
    error: draftError,
    addToReview,
    submitNow,
  } = useReviewCommentDraft(projectId, path);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlame(null);
    setOpen(null);
    api
      .getGitBlame(projectId, path)
      .then((result) => {
        if (cancelled) return;
        setBlame(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("gitStatusLoading"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, t]);

  const codeLines = useMemo(
    () =>
      blame?.highlightedHtml
        ? parseHighlightedLines(blame.highlightedHtml)
        : null,
    [blame],
  );

  // Lines that already carry a pending comment (blame side is always "new").
  const commentedLines = useMemo(() => {
    const set = new Set<number>();
    for (const comment of pending) {
      if (comment.anchor.side === "new" && comment.anchor.newLine !== null) {
        set.add(comment.anchor.newLine);
      }
    }
    return set;
  }, [pending]);

  const openAt = (index: number, rowEl: HTMLElement) => {
    const container = containerRef.current;
    if (!container) return;
    const rowRect = rowEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setOpen({
      index,
      top: rowRect.bottom - containerRect.top + container.scrollTop,
    });
  };

  const submitAnchor = (index: number): ReviewCommentAnchor | null => {
    if (!blame) return null;
    const line = blame.lines[index];
    if (!line) return null;
    const { snippet, offset } = buildBlameSnippet(blame.lines, index);
    return {
      path,
      revision: line.uncommitted
        ? { kind: "uncommitted", savedAt: new Date().toISOString() }
        : { kind: "sha", sha: line.sha },
      side: "new",
      oldLine: null,
      newLine: line.line,
      snippet,
      snippetAnchorOffset: offset,
    };
  };

  const openLine = open && blame ? blame.lines[open.index] : null;

  if (loading) {
    return (
      <section className="blame-view">
        <div className="git-diff-loading">{t("gitStatusLoading")}</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="blame-view">
        <div className="git-diff-error">{error}</div>
      </section>
    );
  }
  if (!blame) return null;

  return (
    <section className="blame-view" ref={containerRef}>
      <div className="blame-view-header">
        <span className="blame-view-path" title={path}>
          {path}
        </span>
        <CopyButton
          value={path}
          title={t("sourceCopyPath")}
          className="source-detail-action"
        />
      </div>
      <div className="blame-lines">
        {blame.lines.map((line, index) => (
          <button
            type="button"
            key={line.line}
            className={`blame-row ${
              commentedLines.has(line.line) ? "has-review-comment" : ""
            }`}
            onClick={(event) => openAt(index, event.currentTarget)}
          >
            <span
              className={`blame-gutter ${line.uncommitted ? "uncommitted" : ""}`}
              title={
                line.uncommitted
                  ? t("sourceBlameNotCommitted")
                  : blameGutterTitle(line)
              }
            >
              {line.uncommitted ? "·······" : line.shortSha}
            </span>
            <span className="blame-lineno">{line.line}</span>
            {codeLines?.[index] ? (
              <span
                className="blame-code"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted line
                dangerouslySetInnerHTML={{ __html: codeLines[index] }}
              />
            ) : (
              <span className="blame-code">{line.content || " "}</span>
            )}
          </button>
        ))}
      </div>
      {blame.truncated && (
        <div className="blame-truncated">{t("sourceBlameTruncated")}</div>
      )}

      {open && openLine && (
        <ReviewCommentWindow
          anchorLabel={`${path}:${openLine.line}`}
          snippet={buildBlameSnippet(blame.lines, open.index).snippet}
          top={open.top}
          busy={busy}
          error={draftError}
          onCancel={() => setOpen(null)}
          onAddToReview={async (text) => {
            const anchor = submitAnchor(open.index);
            if (anchor && (await addToReview(anchor, text))) setOpen(null);
          }}
          onSubmitNow={async (text) => {
            const anchor = submitAnchor(open.index);
            if (!anchor) return;
            const outcome = await submitNow(
              anchor,
              text,
              t("sourceReviewSubmitQueued"),
            );
            if (outcome === "navigated") setOpen(null);
          }}
          t={t}
        />
      )}
    </section>
  );
}

/** Blame gutter hover text: sha · author · date · summary (date when known). */
function blameGutterTitle(line: GitBlameLine): string {
  const date = formatBlameDate(line.authorTime);
  const parts = [line.shortSha, line.author, date, line.summary].filter(
    Boolean,
  );
  return parts.join(" · ");
}

/** Author time as a short local date, or "" when unknown/unparseable. */
function formatBlameDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Clicked line ± radius of blame content, newline-joined, with the offset. */
function buildBlameSnippet(
  lines: GitBlameLine[],
  index: number,
  radius = DEFAULT_SNIPPET_CONTEXT_RADIUS,
): { snippet: string; offset: number } {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  const snippet = lines
    .slice(start, end)
    .map((line) => line.content)
    .join("\n");
  return { snippet, offset: index - start };
}

/** Split highlighted file HTML into each line's inner HTML, by DOM order. */
function parseHighlightedLines(html: string): string[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = doc.querySelectorAll("code .line");
  return Array.from(nodes).map((node) => node.innerHTML);
}
