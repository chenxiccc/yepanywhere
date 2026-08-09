import {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../metadata/index.js";
import type { ServerSettingsService } from "./ServerSettingsService.js";

export async function initializeSessionHeartbeatDefaults(options: {
  sessionId: string;
  projectId: UrlProjectId;
  sessionMetadataService?: SessionMetadataService;
  projectMetadataService?: ProjectMetadataService;
  serverSettingsService?: ServerSettingsService;
}): Promise<void> {
  const sessionMetadataService = options.sessionMetadataService;
  if (!sessionMetadataService) return;
  const current = sessionMetadataService.getMetadata(options.sessionId);
  if (
    current?.heartbeatTurnsAfterMinutes !== undefined &&
    current.heartbeatTurnText !== undefined
  ) {
    return;
  }

  const projectDefaults =
    options.projectMetadataService?.getProjectSessionDefaults(
      options.projectId,
    );
  await sessionMetadataService.updateMetadata(options.sessionId, {
    ...(current?.heartbeatTurnsAfterMinutes === undefined
      ? {
          heartbeatTurnsAfterMinutes:
            projectDefaults?.heartbeatTurnsAfterMinutes ??
            options.serverSettingsService?.getSetting(
              "heartbeatTurnsAfterMinutes",
            ) ??
            DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
        }
      : {}),
    ...(current?.heartbeatTurnText === undefined
      ? {
          heartbeatTurnText:
            projectDefaults?.heartbeatTurnText ??
            options.serverSettingsService?.getSetting("heartbeatTurnText") ??
            DEFAULT_HEARTBEAT_TURN_TEXT,
        }
      : {}),
  });
}
