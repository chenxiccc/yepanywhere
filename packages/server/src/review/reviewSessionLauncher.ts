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

export interface ReviewSessionLauncher {
  /** Start a fresh review session whose first turn is `text`. */
  startReviewSession(
    projectPath: string,
    text: string,
  ): Promise<ReviewLaunchResult>;
  /**
   * Deliver `text` as a follow-up turn to a live session. Returns false when
   * the session has no live process (nothing to deliver to).
   */
  deliverFollowUp(sessionId: string, text: string): Promise<boolean>;
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

    async deliverFollowUp(sessionId, text) {
      const process = supervisor.getProcessForSession(sessionId);
      if (!process) return false;
      process.queueMessage({ text });
      return true;
    },
  };
}
