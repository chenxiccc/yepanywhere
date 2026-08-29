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

export interface ProjectQueueAffordanceState {
  projectId?: string | null;
  currentSessionId?: string | null;
  currentSessionBlocksProjectQueue?: boolean;
  currentSessionHasSessionQueueBacklog?: boolean;
  activeProjectSessionIds?: readonly string[];
  projectQueueBlockingCount?: number | null;
  projectQueueItemCount?: number | null;
}

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

export function shouldShowProjectQueueAffordance({
  projectId,
  currentSessionId,
  currentSessionBlocksProjectQueue = false,
  currentSessionHasSessionQueueBacklog = false,
  activeProjectSessionIds = [],
  projectQueueBlockingCount = null,
  projectQueueItemCount = 0,
}: ProjectQueueAffordanceState): boolean {
  if (!projectId) return false;
  if ((projectQueueItemCount ?? 0) > 0) return true;

  let knownCurrentSessionBlocksProjectQueue =
    currentSessionBlocksProjectQueue || currentSessionHasSessionQueueBacklog;
  for (const activeSessionId of activeProjectSessionIds) {
    if (activeSessionId === currentSessionId) {
      knownCurrentSessionBlocksProjectQueue = true;
      continue;
    }
    return true;
  }

  if (projectQueueBlockingCount !== null) {
    const currentBlockingCount = knownCurrentSessionBlocksProjectQueue ? 1 : 0;
    if (projectQueueBlockingCount > currentBlockingCount) {
      return true;
    }
  }

  return currentSessionHasSessionQueueBacklog;
}
