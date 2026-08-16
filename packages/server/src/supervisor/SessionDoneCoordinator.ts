import { randomUUID } from "node:crypto";
import type { DurableSyntheticDoneMessage } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { Process } from "./Process.js";

export interface SessionDoneResult {
  message: DurableSyntheticDoneMessage;
  paused: true;
  queued: boolean;
}

export interface SessionDoneCoordinatorOptions {
  sessionMetadataService?: SessionMetadataService;
  notificationService?: NotificationService;
  getProcessForSession(sessionId: string): Process | undefined;
  cancelInFlightForkedRecap(process: Process): void;
  requestHeartbeatSweep(): void;
}

export function syntheticDoneMessage(
  uuid: string,
  timestamp: string,
): DurableSyntheticDoneMessage {
  return {
    type: "user",
    content: "/done",
    message: { role: "user", content: "/done" },
    timestamp,
    uuid,
    id: uuid,
    isSynthetic: true,
    yaSyntheticSource: "done",
  };
}

/**
 * Owns `/done` request, durable automation pause, and idle finalize.
 * Process still holds the Process-local `ya-command` chip and idle-boundary
 * hold; this coordinator is the persist/resume policy those chips sit under.
 */
export class SessionDoneCoordinator {
  constructor(private readonly options: SessionDoneCoordinatorOptions) {}

  isAutomationPausedUntilUserTurn(sessionId: string): boolean {
    return (
      this.options
        .getProcessForSession(sessionId)
        ?.hasPendingYaCommand("done") === true ||
      this.options.sessionMetadataService?.getMetadata(sessionId)
        ?.automationPausedUntilUserTurn === true
    );
  }

  async requestSessionDone(sessionId: string): Promise<SessionDoneResult> {
    const metadata = this.requireMetadata();
    const process = this.options.getProcessForSession(sessionId);
    const existing = process?.getPendingYaCommand("done");
    const hasActiveTurn =
      process !== undefined &&
      (process.state.type === "in-turn" ||
        process.state.type === "waiting-input" ||
        process.isRetainingProviderWork());

    if (process && (existing || hasActiveTurn)) {
      await this.persistAutomationPause(sessionId);
      const pending = existing ?? process.queueYaCommand("done");
      this.pauseLiveProcess(process);

      if (process.state.type === "idle" && !process.isRetainingProviderWork()) {
        const completed = await this.finalizePendingDone(process);
        if (completed) {
          return { message: completed, paused: true, queued: false };
        }
      }

      return {
        message: syntheticDoneMessage(pending.tempId, pending.timestamp),
        paused: true,
        queued: true,
      };
    }

    const timestamp = new Date().toISOString();
    const uuid = `ya-done-${randomUUID()}`;
    const message = syntheticDoneMessage(uuid, timestamp);
    await metadata.recordSyntheticDone(sessionId, message);
    if (process) {
      this.pauseLiveProcess(process);
    } else {
      this.options.requestHeartbeatSweep();
    }
    await this.options.notificationService?.markSeen(
      sessionId,
      timestamp,
      uuid,
    );
    return { message, paused: true, queued: false };
  }

  async finalizePendingDone(
    process: Process,
  ): Promise<DurableSyntheticDoneMessage | null> {
    const pending = process.beginPendingYaCommandCompletion("done");
    if (!pending) {
      return null;
    }

    const metadata = this.options.sessionMetadataService;
    if (!metadata) {
      process.releasePendingYaCommandCompletion(pending.tempId);
      return null;
    }

    const timestamp = new Date().toISOString();
    const message = syntheticDoneMessage(pending.tempId, timestamp);
    try {
      await metadata.recordSyntheticDone(process.sessionId, message);
      this.pauseLiveProcess(process);
      await this.options.notificationService?.markSeen(
        process.sessionId,
        timestamp,
        pending.tempId,
      );
      if (process.userTurnVersion > pending.userTurnVersion) {
        await metadata.updateMetadata(process.sessionId, {
          automationPausedUntilUserTurn: false,
        });
        process.resumeRecapsAfterUserTurn();
        process.handleAutomationPauseChanged();
        this.options.requestHeartbeatSweep();
      }
    } catch (error) {
      process.releasePendingYaCommandCompletion(pending.tempId);
      getLogger().warn(
        {
          event: "pending_done_finalize_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to finalize queued /done command",
      );
      return null;
    }

    process.completePendingYaCommand(pending.tempId);
    return message;
  }

  async pauseSessionAutomation(sessionId: string): Promise<void> {
    const process = this.options.getProcessForSession(sessionId);
    if (process) {
      this.pauseLiveProcess(process);
      return;
    }
    this.options.requestHeartbeatSweep();
  }

  resumeAfterUserTurn(process: Process): void {
    if (!this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return;
    }
    void this.options.sessionMetadataService
      ?.updateMetadata(process.sessionId, {
        automationPausedUntilUserTurn: false,
      })
      .then(() => {
        process.handleAutomationPauseChanged();
        this.options.requestHeartbeatSweep();
      })
      .catch((error) => {
        getLogger().warn(
          {
            event: "session_automation_resume_persistence_failed",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to clear session automation pause",
        );
      });
  }

  private requireMetadata(): SessionMetadataService {
    const metadata = this.options.sessionMetadataService;
    if (!metadata) {
      throw new Error("Session metadata service unavailable");
    }
    return metadata;
  }

  private async persistAutomationPause(sessionId: string): Promise<void> {
    await this.requireMetadata().updateMetadata(sessionId, {
      automationPausedUntilUserTurn: true,
    });
  }

  private pauseLiveProcess(process: Process): void {
    process.pauseRecapsUntilUserTurn();
    this.options.cancelInFlightForkedRecap(process);
    process.handleAutomationPauseChanged();
    this.options.requestHeartbeatSweep();
  }
}
