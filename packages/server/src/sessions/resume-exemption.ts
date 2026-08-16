/**
 * Resume exemption for explicitly killed or locally completed sessions.
 *
 * When the user kills a session through YA's explicit Kill action, the
 * session must not come back through an automatic YA resume path. The durable
 * exemption lives in YA metadata and is checked by every automatic process-
 * start path. Provider transcripts remain untouched so history stays readable
 * and the user can deliberately continue the session.
 *
 * See topics/session-liveness.md and topics/heartbeat.md ("Unowned resume
 * exemptions").
 */

import type { SessionMetadata } from "../metadata/SessionMetadataService.js";

/** Whether YA may start a provider process without a fresh user action. */
export function isAutomaticSessionResumeAllowed(
  metadata:
    | Pick<
        SessionMetadata,
        "autoResumeDisabled" | "automationPausedUntilUserTurn"
      >
    | undefined,
): boolean {
  return (
    metadata?.autoResumeDisabled !== true &&
    metadata?.automationPausedUntilUserTurn !== true
  );
}

/**
 * Whether an unowned session may be auto-resumed by the heartbeat candidate
 * scan. Archived sessions are exempt: archiving says the user is done with
 * the session, so resurrecting it contradicts the gesture.
 */
export function isUnownedHeartbeatResumeEligible(
  metadata: Pick<
    SessionMetadata,
    | "heartbeatTurnsEnabled"
    | "isArchived"
    | "autoResumeDisabled"
    | "automationPausedUntilUserTurn"
  >,
): boolean {
  return (
    metadata.heartbeatTurnsEnabled === true &&
    metadata.isArchived !== true &&
    isAutomaticSessionResumeAllowed(metadata)
  );
}

/** Outcome of blocking auto-resume for an explicitly killed session. */
export interface ResumeExemptionResult {
  /** True when the session had heartbeat turns enabled and they were cleared. */
  heartbeatDisabled: boolean;
  /** Whether YA's durable automatic-resume gate is blocked. */
  autoResumeDisabled: boolean;
  /** Present when shutdown succeeded but the durable exemption failed. */
  error?: string;
}
