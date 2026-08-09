import type { UrlProjectId } from "./projectId.js";

export const DEFAULT_HEARTBEAT_TURN_TEXT = "continue";
export const DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES = 15;
export const MAX_HEARTBEAT_TURN_TEXT_LENGTH = 2_000;
export const MAX_PROJECT_HEARTBEAT_RECENT_TEXTS = 8;

export interface ProjectSessionDefaultOverrides {
  heartbeatTurnsAfterMinutes: number | null;
  heartbeatTurnText: string | null;
}

export interface ProjectSessionDefaultsResponse {
  projectId: UrlProjectId;
  overrides: ProjectSessionDefaultOverrides;
  recentHeartbeatTurnTexts: string[];
}

export interface UpdateProjectSessionDefaultsRequest {
  heartbeatTurnsAfterMinutes?: number | null;
  heartbeatTurnText?: string | null;
}
