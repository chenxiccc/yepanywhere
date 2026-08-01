/**
 * The narrow session-launch seam the review submit endpoint needs (topic:
 * source-review-to-session). Segregated from the full Supervisor so the route
 * is testable with a small stub; the real implementation is thin glue over
 * `supervisor.startSession` / `getProcessForSession().queueMessage`.
 */

import type { ReviewNewSessionOptions } from "@yep-anywhere/shared";
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
    options?: ReviewNewSessionOptions,
    submissionId?: string,
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
    submissionId?: string,
  ): Promise<ReviewFollowUpResult>;
}

export interface ReviewDeliveryAcceptance {
  deliveryStatus: "queued" | "delivered";
  targetSessionId?: string;
}

export function createSupervisorReviewLauncher(
  supervisor: Supervisor,
  onDeliveryAccepted?: (
    projectPath: string,
    submissionId: string,
    acceptance: ReviewDeliveryAcceptance,
  ) => void | Promise<void>,
): ReviewSessionLauncher {
  const starts = new Map<string, Promise<ReviewLaunchResult>>();
  const followUps = new Map<string, Promise<ReviewFollowUpResult>>();
  return {
    async startReviewSession(projectPath, text, options, submissionId) {
      if (submissionId) {
        const key = `${projectPath}\0${submissionId}`;
        const existing = starts.get(key);
        if (existing) return existing;
        const pending = start(projectPath, text, options, submissionId);
        starts.set(key, pending);
        let result: ReviewLaunchResult;
        try {
          result = await pending;
        } catch (error) {
          starts.delete(key);
          throw error;
        }
        if (result.status === "queue-full") starts.delete(key);
        trimOldest(starts);
        return result;
      }
      return start(projectPath, text, options);
    },

    async deliverFollowUp(projectPath, sessionId, text, submissionId) {
      if (submissionId) {
        const key = `${projectPath}\0${submissionId}`;
        const existing = followUps.get(key);
        if (existing) return existing;
        const pending = followUp(projectPath, sessionId, text, submissionId);
        followUps.set(key, pending);
        let result: ReviewFollowUpResult;
        try {
          result = await pending;
        } catch (error) {
          followUps.delete(key);
          throw error;
        }
        if (result.status === "queue-full") followUps.delete(key);
        trimOldest(followUps);
        return result;
      }
      return followUp(projectPath, sessionId, text);
    },
  };

  async function start(
    projectPath: string,
    text: string,
    options?: ReviewNewSessionOptions,
    submissionId?: string,
  ): Promise<ReviewLaunchResult> {
    // projectId derives from projectPath inside startSession.
    const modelSettings = options
      ? {
          providerName: options.provider,
          model: options.model,
          thinking: options.thinking,
          effort: options.effort,
        }
      : undefined;
    const result = submissionId
      ? await supervisor.startSession(
          projectPath,
          reviewMessage(text, submissionId),
          undefined,
          modelSettings,
          {
            onStarted: (sessionId) =>
              onDeliveryAccepted?.(projectPath, submissionId, {
                deliveryStatus: "delivered",
                targetSessionId: sessionId,
              }),
          },
        )
      : await supervisor.startSession(
          projectPath,
          reviewMessage(text),
          undefined,
          modelSettings,
        );
    if ("error" in result) {
      return { status: "queue-full", maxQueueSize: result.maxQueueSize };
    }
    if ("queued" in result) {
      if (submissionId) {
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "queued",
        });
      }
      return { status: "queued" };
    }
    return { status: "started", sessionId: result.sessionId };
  }

  async function followUp(
    projectPath: string,
    sessionId: string,
    text: string,
    submissionId?: string,
  ): Promise<ReviewFollowUpResult> {
    const process = supervisor.getProcessForSession(sessionId);
    if (process) {
      process.queueMessage(reviewMessage(text, submissionId));
      if (submissionId) {
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "delivered",
          targetSessionId: sessionId,
        });
      }
      return { status: "delivered" };
    }
    // Reaped: resume the session from its jsonl and deliver the turn.
    const result = await supervisor.resumeSession(
      sessionId,
      projectPath,
      reviewMessage(text, submissionId),
    );
    if ("error" in result) {
      return { status: "queue-full", maxQueueSize: result.maxQueueSize };
    }
    if ("queued" in result) {
      if (submissionId) {
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "queued",
          targetSessionId: sessionId,
        });
      }
      return { status: "queued" };
    }
    if (submissionId) {
      await onDeliveryAccepted?.(projectPath, submissionId, {
        deliveryStatus: "delivered",
        targetSessionId: sessionId,
      });
    }
    return { status: "delivered" };
  }
}

function reviewMessage(text: string, submissionId?: string) {
  if (!submissionId) return { text };
  return {
    text,
    tempId: `source-review-${submissionId}`,
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      submissionId,
    )
      ? { uuid: submissionId }
      : {}),
    metadata: { sourceReviewSubmissionId: submissionId },
  };
}

function trimOldest<T>(map: Map<string, Promise<T>>): void {
  if (map.size <= 2_000) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}
