import type { UrlProjectId } from "@yep-anywhere/shared";

export interface ProjectWorkProcessSnapshot {
  sessionId: string;
  projectId: UrlProjectId;
  state: { type: string };
  queueDepth: number;
  isRetainingProviderWork(): boolean;
  getPendingInputRequest(): unknown;
  getDeferredQueueSummary(): readonly unknown[];
  getLivenessSnapshot(): { derivedStatus: string };
}

export interface ProjectWorkSupervisor {
  getAllProcesses(): ProjectWorkProcessSnapshot[];
  getQueueInfo(): { projectId: UrlProjectId }[];
}

export interface ProjectWorkExternalTracker {
  getExternalSessions(): string[];
  getExternalSessionInfoWithUrlId(
    sessionId: string,
  ): Promise<{ projectId: UrlProjectId; lastActivity: Date } | null>;
}

export interface ProjectWorkIdleStatus {
  idle: boolean;
  blockers: string[];
}

/**
 * Shared "is the project quiet enough for automated follow-up work" predicate.
 * Callers can layer their own queue semantics on top of this base check.
 */
export async function getProjectWorkIdleStatus(
  projectId: UrlProjectId,
  options: {
    supervisor: ProjectWorkSupervisor;
    externalTracker?: ProjectWorkExternalTracker;
    getRecoveredPatientQueueCount?: (projectId: UrlProjectId) => number;
  },
): Promise<ProjectWorkIdleStatus> {
  const blockers: string[] = [];

  for (const process of options.supervisor.getAllProcesses()) {
    if (process.projectId !== projectId) continue;
    const stateType = process.state.type;
    if (stateType === "in-turn" || stateType === "waiting-input") {
      blockers.push(`${process.sessionId}:${stateType}`);
    }
    if (process.isRetainingProviderWork()) {
      blockers.push(`${process.sessionId}:provider-retained`);
    }
    if (process.queueDepth > 0) {
      blockers.push(`${process.sessionId}:direct-queue`);
    }
    if (process.getDeferredQueueSummary().length > 0) {
      blockers.push(`${process.sessionId}:deferred-queue`);
    }
    if (process.getPendingInputRequest()) {
      blockers.push(`${process.sessionId}:pending-input`);
    }
    const liveness = process.getLivenessSnapshot();
    if (liveness.derivedStatus !== "verified-idle") {
      blockers.push(`${process.sessionId}:liveness-${liveness.derivedStatus}`);
    }
  }

  for (const request of options.supervisor.getQueueInfo()) {
    if (request.projectId === projectId) {
      blockers.push("worker-queue");
    }
  }

  const recoveredPatientQueueCount =
    options.getRecoveredPatientQueueCount?.(projectId) ?? 0;
  if (recoveredPatientQueueCount > 0) {
    blockers.push(`recovered-session-queue:${recoveredPatientQueueCount}`);
  }

  if (options.externalTracker) {
    for (const sessionId of options.externalTracker.getExternalSessions()) {
      const info =
        await options.externalTracker.getExternalSessionInfoWithUrlId(
          sessionId,
        );
      if (info?.projectId === projectId) {
        blockers.push(`${sessionId}:external`);
      }
    }
  }

  return { idle: blockers.length === 0, blockers };
}
