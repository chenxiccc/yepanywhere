import type { ReviewComment, ReviewCommentAnchor } from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

/**
 * Client for the source-review draft-comment endpoints (topic:
 * source-review-to-session). Mirrors `routes/review-comments.ts`.
 */

export interface ReviewCommentsList {
  comments: ReviewComment[];
  pendingCount: number;
}

export interface ReviewSubmitResult {
  /** Present when a session was started or continued. */
  sessionId?: string;
  batchId?: string;
  consumed?: string[];
  /** "queued" (HTTP 202) when the supervisor was at capacity. */
  status?: "queued";
}

export const reviewApi = {
  listReviewComments: (projectId: string) =>
    fetchJSON<ReviewCommentsList>(`/projects/${projectId}/review/comments`),

  addReviewComment: (
    projectId: string,
    anchor: ReviewCommentAnchor,
    text: string,
  ) =>
    fetchJSON<{ comment: ReviewComment }>(
      `/projects/${projectId}/review/comments`,
      { method: "POST", body: JSON.stringify({ anchor, text }) },
    ),

  updateReviewComment: (
    projectId: string,
    commentId: string,
    patch: { text?: string; anchor?: ReviewCommentAnchor },
  ) =>
    fetchJSON<{ comment: ReviewComment }>(
      `/projects/${projectId}/review/comments/${commentId}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  deleteReviewComment: (projectId: string, commentId: string) =>
    fetchJSON<{ ok: true }>(
      `/projects/${projectId}/review/comments/${commentId}`,
      { method: "DELETE" },
    ),

  submitReview: (
    projectId: string,
    include: string[],
    target: "new" | string,
  ) =>
    fetchJSON<ReviewSubmitResult>(`/projects/${projectId}/review/submit`, {
      method: "POST",
      body: JSON.stringify({ include, target }),
    }),
};
