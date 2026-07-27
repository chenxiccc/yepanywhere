import type { ReviewComment, ReviewCommentAnchor } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  notifyReviewCommentsChanged,
  subscribeReviewComments,
} from "../lib/reviewCommentsBus";
import { useRemoteBasePath } from "./useRemoteBasePath";

export type SubmitNowOutcome = "navigated" | "queued" | "error";

/**
 * Shared review-draft actions for the diff and blame comment surfaces (topic:
 * source-review-to-session). Tracks this file's pending comments (for the
 * tint), "add to review" (persist a pending draft), and "submit now" (drain one
 * comment into a fresh session and navigate). Extracted so the two comment
 * layers never duplicate the add/submit/navigate logic — the anchor is the only
 * thing each surface builds differently.
 */
export function useReviewCommentDraft(projectId: string, filePath: string) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
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

  // Refresh on mount and whenever any surface mutates the accumulator (a
  // tray submit, a Comments-tab delete), so this file's tint never goes stale.
  useEffect(() => {
    void refreshPending();
    return subscribeReviewComments(projectId, () => {
      void refreshPending();
    });
  }, [projectId, refreshPending]);

  const addToReview = useCallback(
    async (anchor: ReviewCommentAnchor, text: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const { comment } = await api.addReviewComment(projectId, anchor, text);
        setPending((prev) => [...prev, comment]);
        notifyReviewCommentsChanged(projectId);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add comment");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const submitNow = useCallback(
    async (
      anchor: ReviewCommentAnchor,
      text: string,
      queuedMessage: string,
    ): Promise<SubmitNowOutcome> => {
      setBusy(true);
      setError(null);
      try {
        const { comment } = await api.addReviewComment(projectId, anchor, text);
        const result = await api.submitReview(projectId, [comment.id], "new");
        notifyReviewCommentsChanged(projectId);
        if (result.sessionId) {
          navigate(
            `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
          );
          return "navigated";
        }
        // Queued at capacity: the comment stays pending for a retry.
        setError(queuedMessage);
        void refreshPending();
        return "queued";
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to submit");
        return "error";
      } finally {
        setBusy(false);
      }
    },
    [projectId, navigate, basePath, refreshPending],
  );

  return {
    pending,
    busy,
    error,
    setError,
    refreshPending,
    addToReview,
    submitNow,
  };
}
