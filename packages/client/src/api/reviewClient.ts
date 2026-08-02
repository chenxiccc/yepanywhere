import type {
  ReviewBatch,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewNewSessionOptions,
  ReviewReviewerEntry,
  ReviewSubmissionDetail,
  ReviewSubmissionSummary,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

/**
 * Client for the source-review draft-comment endpoints (topic:
 * source-review-to-session). Mirrors `routes/review-comments.ts`.
 */

export interface ReviewCommentsList {
  comments: ReviewComment[];
  batches: ReviewBatch[];
  pendingCount: number;
}

/**
 * Structural mirror of the server's per-comment relocation (from
 * `relocateAnchors.ts`) — flattened so the client needs no server import.
 */
export interface ReviewPreviewRelocation {
  status: "relocated" | "gone";
  path: string;
  line?: number;
  snippet: string;
  currentSha?: string | null;
  citeSha?: string | null;
  moved?: boolean;
}

export interface ReviewPreviewItem {
  comment: ReviewComment;
  relocation: ReviewPreviewRelocation;
  /** Server's suggestion — true for gone (stale) comments. */
  defaultDiscard: boolean;
}

export interface ReviewPreviewResult {
  /** Gone (stale) comments first, per the discard-default ordering. */
  items: ReviewPreviewItem[];
  pendingCount: number;
}

export interface ReviewSubmitResult {
  /** Present when a session was started or continued. */
  sessionId?: string;
  batchId?: string;
  consumed?: string[];
  /** "queued" (HTTP 202) when the supervisor was at capacity. */
  status?: "queued";
  submissionId?: string;
}

export interface ReviewSubmissionPage {
  submissions: ReviewSubmissionSummary[];
  nextCursor: string | null;
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

  previewReview: (projectId: string) =>
    fetchJSON<ReviewPreviewResult>(`/projects/${projectId}/review/preview`, {
      method: "POST",
    }),

  submitReview: (
    projectId: string,
    include: string[],
    target: "new" | string,
    newSession?: ReviewNewSessionOptions,
    submission?: { id: string; name?: string },
  ) =>
    fetchJSON<ReviewSubmitResult>(`/projects/${projectId}/review/submit`, {
      method: "POST",
      body: JSON.stringify({
        include,
        target,
        newSession,
        ...(submission
          ? { submissionId: submission.id, name: submission.name }
          : {}),
      }),
    }),

  listReviewSubmissions: (
    projectId: string,
    options?: { cursor?: string; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.limit) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params}` : "";
    return fetchJSON<ReviewSubmissionPage>(
      `/projects/${projectId}/review/submissions${query}`,
    );
  },

  getReviewSubmission: (projectId: string, submissionId: string) =>
    fetchJSON<ReviewSubmissionDetail>(
      `/projects/${projectId}/review/submissions/${encodeURIComponent(submissionId)}`,
    ),

  addReviewFollowUp: (projectId: string, siteId: string, text: string) =>
    fetchJSON<{ entry: ReviewReviewerEntry }>(
      `/projects/${projectId}/review/sites/${encodeURIComponent(siteId)}/follow-ups`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),

  resolveReviewSite: (projectId: string, siteId: string) =>
    fetchJSON<{ resolved: true }>(
      `/projects/${projectId}/review/sites/${encodeURIComponent(siteId)}/resolve`,
      { method: "POST" },
    ),

  acknowledgeReviewSubmission: (projectId: string, submissionId: string) =>
    fetchJSON<{ submission: ReviewSubmissionSummary }>(
      `/projects/${projectId}/review/submissions/${encodeURIComponent(submissionId)}/acknowledge`,
      { method: "POST" },
    ),
};
