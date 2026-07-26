/**
 * The narrow session-launch seam the review submit endpoint needs (topic:
 * source-review-to-session). Segregated from the full Supervisor so the route
 * is testable with a small stub; the real implementation is thin glue over
 * `supervisor.startSession` / `getProcessForSession().queueMessage`.
 */

import type { Supervisor } from "../supervisor/Supervisor.js";

export type ReviewLaunchResult =
  | { status: "started"; sessionId: string }
  | { status: "queued" }
  | { status: "queue-full"; maxQueueSize?: number };

/** Outcome of delivering a follow-up turn (possibly resuming a reaped session). */
export type ReviewFollowUpResult =
  | { status: "delivered" }
  | { status: "queued" }
  | { status: "queue-full"; maxQueueSize?: number };

export interface ReviewSessionLauncher {
  /** Start a fresh review session whose first turn is `text`. */
  startReviewSession(
    projectPath: string,
    text: string,
  ): Promise<ReviewLaunchResult>;
  /**
   * Deliver `text` as a follow-up turn to `sessionId`. When the session has a
   * live process the turn is queued to it; when it has been reaped (no live
   * process — the common case for a review session idle for a while), it is
   * resumed from its jsonl and the turn delivered, rather than failing.
   */
  deliverFollowUp(
    projectPath: string,
    sessionId: string,
    text: string,
  ): Promise<ReviewFollowUpResult>;
}

export function createSupervisorReviewLauncher(
  supervisor: Supervisor,
): ReviewSessionLauncher {
  return {
    async startReviewSession(projectPath, text) {
      // projectId derives from projectPath inside startSession.
      const result = await supervisor.startSession(projectPath, { text });
      if ("error" in result) {
        return { status: "queue-full", maxQueueSize: result.maxQueueSize };
      }
      if ("queued" in result) {
        return { status: "queued" };
      }
      return { status: "started", sessionId: result.sessionId };
    },

    async deliverFollowUp(projectPath, sessionId, text) {
      const process = supervisor.getProcessForSession(sessionId);
      if (process) {
        process.queueMessage({ text });
        return { status: "delivered" };
      }
      // Reaped: resume the session from its jsonl and deliver the turn.
      const result = await supervisor.resumeSession(sessionId, projectPath, {
        text,
      });
      if ("error" in result) {
        return { status: "queue-full", maxQueueSize: result.maxQueueSize };
      }
      if ("queued" in result) {
        return { status: "queued" };
      }
      return { status: "delivered" };
    },
  };
}
