import type {
  PermissionMode,
  ProviderName,
  SessionSandboxLevel,
  ShowThinking,
  ThinkingOption,
} from "./types.js";
import type { StagedAttachmentRef, UploadedFile } from "./upload.js";
import type { UrlProjectId } from "./projectId.js";
import type { UserMessageMetadata } from "./user-message-metadata.js";
import type { SessionQueuedMessageSummary } from "./app-types.js";

export const DEFAULT_PROJECT_QUEUE_QUIET_SECONDS = 30;
export const MAX_PROJECT_QUEUE_QUIET_SECONDS = 5 * 60;

export function clampProjectQueueQuietSeconds(
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(
    MAX_PROJECT_QUEUE_QUIET_SECONDS,
    Math.max(0, Math.round(value)),
  );
}

export type ProjectQueueItemStatus = "queued" | "dispatching" | "failed";

export type ProjectQueueDispatchPauseReason = "manual" | "restart";

export type ProjectQueueDispatchState =
  | { status: "running" }
  | {
      status: "paused";
      reason: ProjectQueueDispatchPauseReason;
      pausedAt: string;
    };

export type ProjectQueueProjectState =
  | "empty"
  | "paused"
  | "blocked"
  | "waiting-quiet"
  | "ready"
  | "dispatching";

export interface ProjectQueueProjectStatus {
  projectId: UrlProjectId;
  state: ProjectQueueProjectState;
  idle: boolean;
  blockers: string[];
  dispatchPaused: boolean;
  inFlight: boolean;
  quietWindowMs: number;
  itemCount: number;
  nextItemId?: string;
  nextAttemptAt?: string;
  quietStartedAt?: string;
  quietEligibleAt?: string;
}

export interface ProjectQueuePromoteNowResult {
  promoted: boolean;
  itemId?: string;
  sessionId?: string;
  reason:
    | "promoted"
    | "empty"
    | "paused"
    | "blocked"
    | "in-flight"
    | "not-found"
    | "not-queued"
    | "failed";
  error?: string;
  status: ProjectQueueProjectStatus;
}

export interface ProjectQueuePromoteNowRequest {
  itemId?: string;
  force?: boolean;
  /** Deliver an existing-session item through the provider's active-turn steering path. */
  deliveryIntent?: "steer";
}

export type ProjectQueueClientSource =
  | "toolbar"
  | "projects-page"
  | "new-session";

export interface ProjectQueueMessage {
  text: string;
  attachments?: UploadedFile[];
  stagedAttachments?: ProjectQueueStagedAttachments;
  mode?: PermissionMode;
  metadata?: UserMessageMetadata;
}

export interface ProjectQueueStagedAttachments {
  batchId: string;
  refs: StagedAttachmentRef[];
  updatedAt: string;
}

export type ProjectQueueTarget =
  | {
      type: "existing-session";
      sessionId: string;
      provider?: ProviderName;
      mode?: PermissionMode;
      model?: string;
      serviceTier?: string;
      executor?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    }
  | {
      type: "new-session";
      provider?: ProviderName;
      mode?: PermissionMode;
      model?: string;
      serviceTier?: string;
      executor?: string;
      sandboxLevel?: SessionSandboxLevel;
      sandboxNetworkFirewall?: boolean;
      title?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    };

export interface ProjectQueueCreatedFrom {
  sessionId?: string;
  client?: ProjectQueueClientSource;
}

export interface ProjectQueueItem {
  id: string;
  projectId: UrlProjectId;
  projectPath: string;
  target: ProjectQueueTarget;
  message: ProjectQueueMessage;
  createdAt: string;
  updatedAt: string;
  createdFrom?: ProjectQueueCreatedFrom;
  status: ProjectQueueItemStatus;
  lastError?: string;
  lastAttemptAt?: string;
}

export interface ProjectQueueItemSummary {
  id: string;
  projectId: UrlProjectId;
  target: ProjectQueueTarget;
  targetTitle?: string | null;
  targetFullTitle?: string | null;
  messagePreview: string;
  message: ProjectQueueMessage;
  createdAt: string;
  updatedAt: string;
  createdFrom?: ProjectQueueCreatedFrom;
  status: ProjectQueueItemStatus;
  attachmentCount: number;
  lastError?: string;
  lastAttemptAt?: string;
}

export interface ProjectQueueRecoveredSessionQueueSummary
  extends SessionQueuedMessageSummary {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  kind: "patient";
  status: "paused-after-restart";
  sessionTitle?: string;
}

export interface ProjectQueueResponse {
  projectId: UrlProjectId;
  items: ProjectQueueItemSummary[];
  dispatchState?: ProjectQueueDispatchState;
  projectStatuses?: Record<string, ProjectQueueProjectStatus>;
}

export interface ProjectQueueListResponse {
  items: ProjectQueueItemSummary[];
  dispatchState?: ProjectQueueDispatchState;
  recoveredSessionQueues?: ProjectQueueRecoveredSessionQueueSummary[];
  projectStatuses?: Record<string, ProjectQueueProjectStatus>;
}

export interface ProjectQueuePromoteNowResponse
  extends ProjectQueueListResponse {
  promoteResult: ProjectQueuePromoteNowResult;
}

export interface CreateProjectQueueItemRequest {
  target: ProjectQueueTarget;
  message: ProjectQueueMessage;
  createdFrom?: ProjectQueueCreatedFrom;
}

export interface UpdateProjectQueueItemRequest {
  target?: ProjectQueueTarget;
  message?: ProjectQueueMessage;
}

export interface ProjectQueueChangedEvent {
  type: "project-queue-changed";
  projectId: UrlProjectId;
  items: ProjectQueueItemSummary[];
  reason:
    | "created"
    | "updated"
    | "deleted"
    | "retry"
    | "paused"
    | "resumed"
    | "dispatching"
    | "released"
    | "reordered"
    | "promoted"
    | "failed";
  itemId?: string;
  dispatchState?: ProjectQueueDispatchState;
  timestamp: string;
}
