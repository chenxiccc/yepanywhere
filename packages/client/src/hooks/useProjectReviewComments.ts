import type {
  ReviewBatch,
  ReviewComment,
  ReviewSiteStateSummary,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { subscribeReviewComments } from "../lib/reviewCommentsBus";

/**
 * The project's server-owned review comments, kept fresh across the diff
 * viewer and the review tray/modal (topic: source-review-to-session). Refetches
 * on mount and whenever any component signals a change through the bus.
 */
export interface ProjectReviewComments {
  pending: ReviewComment[];
  archived: ReviewComment[];
  batches: ReviewBatch[];
  /** Target of the most recent submitted batch — the default follow-up. */
  recentReviewSessionId: string | null;
  siteStates: ReviewSiteStateSummary[];
  refresh: () => Promise<void>;
}

export function useProjectReviewComments(
  projectId: string | undefined,
  includeSiteStates = false,
): ProjectReviewComments {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [siteStates, setSiteStates] = useState<ReviewSiteStateSummary[]>([]);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setComments([]);
      setBatches([]);
      setSiteStates([]);
      return;
    }
    try {
      const result = await api.listReviewComments(projectId);
      setComments(result.comments);
      setBatches(result.batches);
    } catch {
      // Non-fatal: the tray just shows a stale/empty count.
    }
    if (includeSiteStates) {
      try {
        setSiteStates(await api.listReviewSiteStates(projectId));
      } catch {
        // Capability-gated callers can keep rendering without annotations.
      }
    } else {
      setSiteStates([]);
    }
  }, [includeSiteStates, projectId]);

  useEffect(() => {
    if (!projectId) return;
    void refresh();
    return subscribeReviewComments(projectId, () => {
      void refresh();
    });
  }, [projectId, refresh]);

  return {
    pending: comments.filter((comment) => comment.status === "pending"),
    archived: comments.filter((comment) => comment.status === "archived"),
    batches,
    recentReviewSessionId:
      batches.length > 0
        ? (batches[batches.length - 1]?.targetSessionId ?? null)
        : null,
    siteStates,
    refresh,
  };
}
