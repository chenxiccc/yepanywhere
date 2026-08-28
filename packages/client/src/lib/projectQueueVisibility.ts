import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { isRemoteClient } from "./connection";

export const PROJECT_QUEUE_REMOTE_COMPATIBILITY_LEVEL = 10;
export {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
};

export interface ProjectQueueCapabilitySource {
  capabilities?: readonly string[];
  remoteCompatibilityLevel?: number;
}

export interface ProjectQueueSupportOptions {
  hostedRemote?: boolean;
}

export interface ProjectQueueAffordanceContext {
  projectId?: string | null;
  currentSessionBlocksProjectQueue?: boolean;
  currentSessionHasSessionQueueBacklog?: boolean;
  activeProjectSessionIds?: readonly string[];
  projectQueueBlockingCount?: number | null;
  projectQueueItemCount?: number | null;
}

export type ProjectQueueAffordanceState =
  | "unavailable"
  | "unblocked"
  | "blocked";

export function serverSupportsProjectQueue(
  version: ProjectQueueCapabilitySource | null | undefined,
  options: ProjectQueueSupportOptions = {},
): boolean {
  if (!serverHasCapability(version, PROJECT_QUEUE_CAPABILITY)) {
    return false;
  }

  const hostedRemote = options.hostedRemote ?? isRemoteClient();
  if (!hostedRemote) return true;

  return (
    (version?.remoteCompatibilityLevel ?? 0) >=
    PROJECT_QUEUE_REMOTE_COMPATIBILITY_LEVEL
  );
}

export function serverSupportsProjectQueueNewSessionShortcutSetting(
  version: ProjectQueueCapabilitySource | null | undefined,
  options: ProjectQueueSupportOptions = {},
): boolean {
  return (
    serverSupportsProjectQueue(version, options) &&
    serverHasCapability(
      version,
      PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
    )
  );
}

export function getProjectQueueAffordanceState({
  projectId,
  currentSessionBlocksProjectQueue = false,
  currentSessionHasSessionQueueBacklog = false,
  activeProjectSessionIds = [],
  projectQueueBlockingCount = null,
  projectQueueItemCount = 0,
}: ProjectQueueAffordanceContext): ProjectQueueAffordanceState {
  if (!projectId) return "unavailable";

  const hasBlockingWork =
    currentSessionBlocksProjectQueue ||
    currentSessionHasSessionQueueBacklog ||
    activeProjectSessionIds.length > 0 ||
    (projectQueueBlockingCount ?? 0) > 0 ||
    (projectQueueItemCount ?? 0) > 0;

  return hasBlockingWork ? "blocked" : "unblocked";
}
