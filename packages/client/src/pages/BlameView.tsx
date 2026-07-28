import {
  DEFAULT_SNIPPET_CONTEXT_RADIUS,
  type FileContentResponse,
  type GitBlameLine,
  type GitBlameResult,
  type ReviewCommentAnchor,
} from "@yep-anywhere/shared";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import type { TranslationFn } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";
import { ReviewCommentWindow } from "./ReviewCommentWindow";
import {
  createBlameLineWidthCacheKey,
  getBlameTypographySignature,
  measureBlameDetailWidth,
} from "./blameContentWidth";
import {
  assignBlameAuthorColorSlots,
  blameAuthorHue,
  getBlameAuthorKey,
  groupConsecutiveBlameRows,
} from "./blamePresentation";

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
  onContentWidthChange,
  t,
}: {
  projectId: string;
  path: string;
  onOpenCommit?: (sha: string) => void;
  onContentWidthChange?: (path: string, width: number) => void;
  t: TranslationFn;
}) {
  const [file, setFile] = useState<FileContentResponse | null>(null);
  const [blame, setBlame] = useState<GitBlameResult | null>(null);
  const [contentLoading, setContentLoading] = useState(true);
  const [blameLoading, setBlameLoading] = useState(true);
  const [contentError, setContentError] = useState<string | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenBlameComment | null>(null);
  const [typographyVersion, setTypographyVersion] = useState(0);
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
  const renderRuns = useMemo(
    () => groupConsecutiveBlameRows(contentLines, blame?.lines),
    [blame?.lines, contentLines],
  );
  const authorColorSlots = useMemo(
    () => assignBlameAuthorColorSlots(blame?.lines ?? []),
    [blame?.lines],
  );
  const lineNumberColumnWidth = `calc(${Math.max(
    1,
    String(contentLines.length).length,
  )}ch + 0.65rem)`;

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTypographyVersion((current) => current + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || contentLoading || !onContentWidthChange) return;
    const typography = getBlameTypographySignature(
      container.querySelector<HTMLElement>(".blame-code") ?? container,
      typographyVersion,
    );
    const presentation = codeLines
      ? `highlight:${blame?.highlightedLanguage ?? "unknown"}`
      : "plain";
    const cacheKey = createBlameLineWidthCacheKey({
      projectId,
      path,
      lines: contentLines,
      typography: `${typography}|${presentation}`,
    });
    onContentWidthChange(path, measureBlameDetailWidth(container, cacheKey));
  }, [
    blame?.highlightedLanguage,
    codeLines,
    contentLines,
    contentLoading,
    onContentWidthChange,
    path,
    projectId,
    typographyVersion,
  ]);

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
        <span className="blame-view-path-group">
          <span className="blame-view-path" title={path}>
            {path}
          </span>
          <CopyButton
            value={path}
            title={t("sourceCopyPath")}
            className="source-detail-action source-detail-icon-action blame-path-copy"
            icon="path"
          />
        </span>
        {blameLoading && (
          <span className="blame-provenance-status" role="status">
            {t("sourceBlameLoading")}
          </span>
        )}
        <CopyButton
          value={file?.content ?? ""}
          title={t("sourceCopyRawContent")}
          className="source-detail-action source-detail-icon-action blame-content-copy"
          disabled={file?.content === undefined || !file.metadata.isText}
          icon="content"
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
      <div
        className="blame-lines"
        style={
          {
            "--blame-line-number-column-width": lineNumberColumnWidth,
          } as CSSProperties
        }
      >
        {renderRuns.map((run) => (
          <div
            className={`blame-run ${run.rows[0]?.line ? "is-scrollable" : ""}`}
            key={run.key}
          >
            {run.rows.map(({ content, index, line }) => {
              const lineNumber = index + 1;
              const menuActions = line ? hashMenuActions(line) : [];
              const authorSlot = line
                ? authorColorSlots.get(getBlameAuthorKey(line))
                : undefined;
              const authorStyle =
                authorSlot === undefined
                  ? undefined
                  : ({
                      "--blame-author-hue": `${blameAuthorHue(authorSlot)}deg`,
                    } as CSSProperties);
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
                      ·····
                    </span>
                  ) : line ? (
                    <button
                      type="button"
                      className={`blame-gutter blame-commit-link ${
                        authorSlot === undefined ? "" : "has-author-color"
                      }`}
                      style={authorStyle}
                      title={blameGutterTitle(line)}
                      {...hashMenu.targetProps(menuActions, () =>
                        onOpenCommit
                          ? onOpenCommit(line.sha)
                          : void writeClipboardText(line.sha),
                      )}
                    >
                      {line.shortSha.slice(0, 5)}
                    </button>
                  ) : (
                    <span
                      className="blame-gutter blame-gutter-loading"
                      title={t("sourceBlameLoading")}
                    >
                      ·····
                    </span>
                  )}
                  <button
                    type="button"
                    className="blame-lineno"
                    disabled={!line}
                    onClick={(event) => openAt(index, event.currentTarget)}
                  >
                    {lineNumber}
                  </button>
                  <BlameCodeCell
                    content={content}
                    highlightedHtml={codeLines?.[index]}
                    enabled={Boolean(line)}
                    onOpen={(element) => openAt(index, element)}
                  />
                </div>
              );
            })}
          </div>
        ))}
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

function BlameCodeCell({
  content,
  highlightedHtml,
  enabled,
  onOpen,
}: {
  content: string;
  highlightedHtml: string | undefined;
  enabled: boolean;
  onOpen: (element: HTMLElement) => void;
}) {
  const sharedProps = {
    className: "blame-code blame-line-target",
    role: enabled ? ("button" as const) : undefined,
    tabIndex: enabled ? 0 : undefined,
    onClick: (event: MouseEvent<HTMLSpanElement>) => {
      if (enabled && !selectionContainsText(event.currentTarget)) {
        onOpen(event.currentTarget);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
      if (!enabled || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      onOpen(event.currentTarget);
    },
  };

  return highlightedHtml ? (
    <span
      {...sharedProps}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted line
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  ) : (
    <span {...sharedProps}>{content || " "}</span>
  );
}

function selectionContainsText(element: HTMLElement): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      selection.toString().length > 0 &&
      selection.containsNode(element, true),
  );
}

/** Blame gutter hover text: full sha · author · date · summary. */
function blameGutterTitle(line: GitBlameLine): string {
  const date = formatBlameDate(line.authorTime);
  const parts = [line.sha, line.author, date, line.summary].filter(Boolean);
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
