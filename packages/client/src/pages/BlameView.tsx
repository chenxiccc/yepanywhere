import {
  DEFAULT_SNIPPET_CONTEXT_RADIUS,
  type FileContentResponse,
  type GitBlameLine,
  type GitBlameResult,
  type ReviewCommentAnchor,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { writeClipboardText } from "../lib/clipboard";
import { ReviewCommentWindow } from "./ReviewCommentWindow";
import type { TranslationFn } from "../i18n";

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
  onOpenCommit,
  t,
}: {
  projectId: string;
  path: string;
  onOpenCommit?: (sha: string) => void;
  t: TranslationFn;
}) {
  const [file, setFile] = useState<FileContentResponse | null>(null);
  const [blame, setBlame] = useState<GitBlameResult | null>(null);
  const [contentLoading, setContentLoading] = useState(true);
  const [blameLoading, setBlameLoading] = useState(true);
  const [contentError, setContentError] = useState<string | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenBlameComment | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hashMenu = useSourceContextMenu(t);
  const {
    pending,
    defaultSession,
    busy,
    error: draftError,
    addToReview,
    submitNow,
  } = useReviewCommentDraft(projectId, path);

  useEffect(() => {
    let cancelled = false;
    setContentLoading(true);
    setBlameLoading(true);
    setContentError(null);
    setBlameError(null);
    setFile(null);
    setBlame(null);
    setOpen(null);
    // File content and provenance are independent. The ordinary file endpoint
    // gives the reader useful content immediately; blame enriches the gutter
    // whenever its more expensive Git walk completes.
    api
      .getFile(projectId, path, false)
      .then((result) => {
        if (cancelled) return;
        setFile(result);
        setContentLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setContentError(
          err instanceof Error ? err.message : t("fileViewerLoadFailed"),
        );
        setContentLoading(false);
      });
    api
      .getGitBlame(projectId, path)
      .then((result) => {
        if (cancelled) return;
        setBlame(result);
        setBlameLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setBlameError(
          err instanceof Error ? err.message : t("sourceBlameLoadFailed"),
        );
        setBlameLoading(false);
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
  const contentLines = useMemo(() => {
    if (file?.content !== undefined) return splitFileLines(file.content);
    return blame?.lines.map((line) => line.content) ?? [];
  }, [blame?.lines, file?.content]);

  // Pending tint is exact provenance identity, not merely a line number: the
  // same path/line after a commit must not inherit an older revision's tint.
  const commentedLines = useMemo(() => {
    const set = new Set<number>();
    for (const comment of pending) {
      if (comment.anchor.side !== "new" || comment.anchor.newLine === null) {
        continue;
      }
      const line = blame?.lines[comment.anchor.newLine - 1];
      if (!line || line.line !== comment.anchor.newLine) continue;
      const sameRevision =
        comment.anchor.revision.kind === "uncommitted"
          ? line.uncommitted
          : !line.uncommitted &&
            comment.anchor.revision.kind === "sha" &&
            comment.anchor.revision.sha === line.sha;
      if (sameRevision) set.add(comment.anchor.newLine);
    }
    return set;
  }, [blame?.lines, pending]);

  const hashMenuActions = useCallback(
    (line: GitBlameLine): SourceContextMenuAction[] => [
      {
        label: t("sourceOpenCommit"),
        disabled: line.uncommitted || !onOpenCommit,
        onSelect: () => {
          if (!line.uncommitted) onOpenCommit?.(line.sha);
        },
      },
      {
        label: t("sourceCopyCommitHash"),
        onSelect: () => {
          void writeClipboardText(line.sha);
        },
      },
    ],
    [onOpenCommit, t],
  );

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

  if (contentLoading && !blame) {
    return (
      <section className="blame-view">
        <div className="git-diff-loading">{t("gitStatusLoading")}</div>
      </section>
    );
  }
  if (contentError && blameError && !blame) {
    return (
      <section className="blame-view">
        <div className="git-diff-error">{contentError}</div>
      </section>
    );
  }

  return (
    <section className="blame-view" ref={containerRef}>
      <div className="blame-view-header">
        <span className="blame-view-path" title={path}>
          {path}
        </span>
        {blameLoading && (
          <span className="blame-provenance-status" role="status">
            {t("sourceBlameLoading")}
          </span>
        )}
        <CopyButton
          value={path}
          title={t("sourceCopyPath")}
          className="source-detail-action"
        />
      </div>
      {contentError && (
        <div className="git-diff-error blame-content-error">{contentError}</div>
      )}
      {blameError && (
        <div className="blame-provenance-error" role="status">
          {t("sourceBlameUnavailable")}
        </div>
      )}
      {file && !file.metadata.isText && !blame && (
        <div className="git-status-empty">{t("fileViewerBinary")}</div>
      )}
      <div className="blame-lines">
        {contentLines.map((content, index) => {
          const lineNumber = index + 1;
          const line =
            blame?.lines[index]?.line === lineNumber
              ? blame.lines[index]
              : undefined;
          const menuActions = line ? hashMenuActions(line) : [];
          return (
            <div
              key={lineNumber}
              className={`blame-row ${
                commentedLines.has(lineNumber) ? "has-review-comment" : ""
              }`}
            >
              {line?.uncommitted ? (
                <span
                  className="blame-gutter uncommitted"
                  title={t("sourceBlameNotCommitted")}
                >
                  ·······
                </span>
              ) : line ? (
                <button
                  type="button"
                  className="blame-gutter blame-commit-link"
                  title={blameGutterTitle(line)}
                  {...hashMenu.targetProps(menuActions, () =>
                    onOpenCommit
                      ? onOpenCommit(line.sha)
                      : void writeClipboardText(line.sha),
                  )}
                >
                  {line.shortSha}
                </button>
              ) : (
                <span
                  className="blame-gutter blame-gutter-loading"
                  title={t("sourceBlameLoading")}
                >
                  ·······
                </span>
              )}
              <button
                type="button"
                className="blame-line-target"
                disabled={!line}
                onClick={(event) => openAt(index, event.currentTarget)}
              >
                <span className="blame-lineno">{lineNumber}</span>
                {codeLines?.[index] ? (
                  <span
                    className="blame-code"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted line
                    dangerouslySetInnerHTML={{ __html: codeLines[index] }}
                  />
                ) : (
                  <span className="blame-code">{content || " "}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
      {hashMenu.menu}
      {(blame?.truncated || file?.contentTruncated) && (
        <div className="blame-truncated">{t("sourceBlameTruncated")}</div>
      )}

      {open && openLine && blame && (
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
          defaultSession={defaultSession}
          onSubmitToDefault={
            defaultSession
              ? async (text) => {
                  const anchor = submitAnchor(open.index);
                  if (!anchor) return;
                  const outcome = await submitNow(
                    anchor,
                    text,
                    defaultSession.id,
                    t("sourceReviewSubmitQueued"),
                  );
                  if (outcome === "navigated") setOpen(null);
                }
              : null
          }
          onSubmitToNew={async (text) => {
            const anchor = submitAnchor(open.index);
            if (!anchor) return;
            const outcome = await submitNow(
              anchor,
              text,
              "new",
              t("sourceReviewSubmitQueued"),
              defaultSession?.newSession,
            );
            if (outcome === "navigated") setOpen(null);
          }}
          t={t}
        />
      )}
    </section>
  );
}

/** Blame gutter hover text: full sha · author · date · summary. */
function blameGutterTitle(line: GitBlameLine): string {
  const date = formatBlameDate(line.authorTime);
  const parts = [line.sha, line.author, date, line.summary].filter(
    Boolean,
  );
  return parts.join(" · ");
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
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
