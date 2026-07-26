import {
  type PatchHunk,
  type PatchLineLocation,
  type ReviewComment,
  type ReviewCommentAnchor,
  anchorFromPatch,
  patchLineCount,
} from "@yep-anywhere/shared";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { notifyReviewCommentsChanged } from "../lib/reviewCommentsBus";

/**
 * Source-review commenting over a rendered diff (topic:
 * source-review-to-session, phase P6). A single delegated listener on the diff
 * container maps a click on a server-emitted `[data-diff-line]` node to an
 * anchor via `anchorFromPatch` — never from the DOM's text — and opens a
 * comment window. "Submit now" drains that one comment into a fresh review
 * session; "Add to review" persists it as a pending draft. Lines that already
 * carry a draft comment get a tint.
 */

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface OpenComment {
  flatIndex: number;
  location: PatchLineLocation;
  /** Offset from the container's top, to place the window below the line. */
  top: number;
}

export function DiffCommentLayer({
  projectId,
  filePath,
  structuredPatch,
  containerRef,
  t,
}: {
  projectId: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  containerRef: RefObject<HTMLElement | null>;
  t: TranslationFn;
}) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [open, setOpen] = useState<OpenComment | null>(null);
  const [pending, setPending] = useState<ReviewComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      const result = await api.listReviewComments(projectId);
      setPending(
        result.comments.filter(
          (comment) =>
            comment.status === "pending" && comment.anchor.path === filePath,
        ),
      );
    } catch {
      // Tint is best-effort; a failed load just means no tint.
    }
  }, [projectId, filePath]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  // Delegated click → anchor. A drag-selection is left alone.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const node = (event.target as HTMLElement | null)?.closest(
        "[data-diff-line]",
      );
      if (!node) return;
      const flatIndex = Number(node.getAttribute("data-diff-line"));
      const location = anchorFromPatch(structuredPatch, flatIndex);
      if (!location) return;
      const nodeRect = node.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      setError(null);
      setOpen({
        flatIndex,
        location,
        top: nodeRect.bottom - containerRect.top + el.scrollTop,
      });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [containerRef, structuredPatch]);

  // Tint every line that carries a pending comment. Idempotent decoration of
  // the same server-emitted nodes the click handler addresses.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const commented = new Set<number>();
    const count = patchLineCount(structuredPatch);
    for (let i = 0; i < count; i++) {
      const location = anchorFromPatch(structuredPatch, i);
      if (location && pending.some((c) => anchorMatches(location, c.anchor))) {
        commented.add(i);
      }
    }
    const nodes = el.querySelectorAll<HTMLElement>("[data-diff-line]");
    for (const node of nodes) {
      const index = Number(node.getAttribute("data-diff-line"));
      node.classList.toggle("has-review-comment", commented.has(index));
    }
  }, [containerRef, structuredPatch, pending]);

  const buildAnchor = useCallback(
    (location: PatchLineLocation): ReviewCommentAnchor => ({
      path: filePath,
      // The git-status diff is the working tree — an uncommitted anchor.
      revision: { kind: "uncommitted", savedAt: new Date().toISOString() },
      side: location.side,
      oldLine: location.oldLine,
      newLine: location.newLine,
      snippet: location.snippet,
      snippetAnchorOffset: location.snippetAnchorOffset,
    }),
    [filePath],
  );

  const addToReview = useCallback(
    async (text: string) => {
      if (!open) return;
      setBusy(true);
      setError(null);
      try {
        const { comment } = await api.addReviewComment(
          projectId,
          buildAnchor(open.location),
          text,
        );
        setPending((prev) => [...prev, comment]);
        notifyReviewCommentsChanged(projectId);
        setOpen(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add comment");
      } finally {
        setBusy(false);
      }
    },
    [open, projectId, buildAnchor],
  );

  const submitNow = useCallback(
    async (text: string) => {
      if (!open) return;
      setBusy(true);
      setError(null);
      try {
        const { comment } = await api.addReviewComment(
          projectId,
          buildAnchor(open.location),
          text,
        );
        const result = await api.submitReview(projectId, [comment.id], "new");
        notifyReviewCommentsChanged(projectId);
        if (result.sessionId) {
          setOpen(null);
          navigate(
            `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
          );
          return;
        }
        // Queued at capacity: the comment stays pending for a retry.
        setError(t("sourceReviewSubmitQueued"));
        void refreshPending();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to submit");
      } finally {
        setBusy(false);
      }
    },
    [open, projectId, buildAnchor, navigate, basePath, refreshPending, t],
  );

  if (!open) return null;

  const lineNumber = open.location.newLine ?? open.location.oldLine;
  return (
    <CommentWindow
      anchorLabel={`${filePath}:${lineNumber ?? "?"}`}
      snippet={open.location.snippet}
      top={open.top}
      busy={busy}
      error={error}
      onCancel={() => setOpen(null)}
      onAddToReview={addToReview}
      onSubmitNow={submitNow}
      t={t}
    />
  );
}

function anchorMatches(
  location: PatchLineLocation,
  anchor: ReviewCommentAnchor,
): boolean {
  return (
    location.side === anchor.side &&
    location.oldLine === anchor.oldLine &&
    location.newLine === anchor.newLine
  );
}

function CommentWindow({
  anchorLabel,
  snippet,
  top,
  busy,
  error,
  onCancel,
  onAddToReview,
  onSubmitNow,
  t,
}: {
  anchorLabel: string;
  snippet: string;
  top: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAddToReview: (text: string) => void;
  onSubmitNow: (text: string) => void;
  t: TranslationFn;
}) {
  const [text, setText] = useState("");
  const canSubmit = text.trim().length > 0 && !busy;

  return (
    <div className="review-comment-window" style={{ top }}>
      <div className="review-comment-window-anchor">{anchorLabel}</div>
      <pre className="review-comment-window-snippet">{snippet}</pre>
      <textarea
        className="review-comment-window-input"
        // biome-ignore lint/a11y/noAutofocus: the window opens on an explicit click
        autoFocus
        rows={3}
        value={text}
        placeholder={t("sourceReviewCommentPlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <div className="review-comment-window-error">{error}</div>}
      <div className="review-comment-window-actions">
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
        <button
          type="button"
          className="review-comment-window-submit"
          onClick={() => onSubmitNow(text)}
          disabled={!canSubmit}
        >
          {t("sourceReviewSubmitNow")}
        </button>
      </div>
    </div>
  );
}
