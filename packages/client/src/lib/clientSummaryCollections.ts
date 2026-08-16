import type {
  AgentActivity,
  PendingInputType,
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueListResponse,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
  ProjectQueueResponse,
  ProviderChildSessionSummary,
  ProviderName,
  ProviderRuntimeStatus,
} from "@yep-anywhere/shared";
import type { GlobalSessionItem, InboxResponse } from "../api/client";
import type { Project, SessionStatus } from "../types";
import type { InboxTier } from "./inboxTiers";

export type SessionCollectionObservationKind =
  | "full-snapshot"
  | "partial-snapshot"
  | "partial-event";

export type SessionCollectionObservationSource =
  | "global-sessions"
  | "inbox"
  | "session-created"
  | "session-updated"
  | "metadata-changed"
  | "process-state"
  | "session-status"
  | "session-seen";

export interface SessionCollectionRecord {
  id: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  provider?: ProviderName;
  model?: string;
  projectId?: string;
  projectName?: string;
  ownership?: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  activityInferredFromInboxTier?: boolean;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  autoResumeDisabled?: boolean;
  activeStartedAt?: number;
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  forkedFromSessionId?: string;
  initialPrompt?: string;
  executor?: string;
  lastAgentText?: string;
  providerChildren?: ProviderChildSessionSummary[];
  observedAt: number;
  snapshotObservedAt?: number;
  contentObservedAt?: number;
  metadataObservedAt?: number;
  projectObservedAt?: number;
  lifecycleObservedAt?: number;
  unreadObservedAt?: number;
  eventCreatedAt?: number;
}

export interface SessionCollectionQueryDescriptor {
  scope: "global-sessions";
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
}

export interface SessionCollectionQueryState {
  key: string;
  descriptor: SessionCollectionQueryDescriptor;
  ids: string[];
  hasMore: boolean;
  requestStartedAt: number;
  fetchedAt: number;
}

export interface ProjectCollectionRecord extends Project {
  observedAt: number;
  snapshotObservedAt?: number;
}

export interface ProjectCollectionQueryState {
  key: string;
  ids: string[];
  requestStartedAt: number;
  fetchedAt: number;
}

export interface ProjectCollectionState {
  entities: ReadonlyMap<string, ProjectCollectionRecord>;
  queries: ReadonlyMap<string, ProjectCollectionQueryState>;
}

export interface ProjectQueueCollectionRecord {
  projectId: string;
  items: readonly ProjectQueueItemSummary[];
  observedAt: number;
  snapshotObservedAt?: number;
}

export interface ProjectQueueProjectStatusRecord {
  projectId: string;
  status: ProjectQueueProjectStatus;
  observedAt: number;
}

export interface ProjectQueueCollectionState {
  byProject: ReadonlyMap<string, ProjectQueueCollectionRecord>;
  globalItems: readonly ProjectQueueItemSummary[];
  globalItemsObservedAt?: number;
  dispatchState: ProjectQueueDispatchState;
  dispatchStateObservedAt?: number;
  recoveredSessionQueues: readonly ProjectQueueRecoveredSessionQueueSummary[];
  recoveredSessionQueuesObservedAt?: number;
  projectStatusesByProject: ReadonlyMap<
    string,
    ProjectQueueProjectStatusRecord
  >;
}

export interface ProjectQueueCountSource {
  id: string;
  projectQueueCount?: number;
  snapshotObservedAt?: number;
}

export interface InboxCollectionState {
  tiers: Record<InboxTier, readonly string[]>;
  requestStartedAt?: number;
  fetchedAt?: number;
}

export interface InboxCounts {
  needsAttention: number;
  active: number;
  total: number;
}

export interface SessionCollectionState {
  entities: ReadonlyMap<string, SessionCollectionRecord>;
  queries: ReadonlyMap<string, SessionCollectionQueryState>;
  /** Bounded old-ID aliases retained to absorb late activity events. */
  aliases: ReadonlyMap<string, string>;
}

export interface LocalDecorationState {
  draftSessionIds: ReadonlySet<string>;
  draftObservedAt?: number;
}

export interface ProviderRuntimeStatusRecord {
  sessionId: string;
  projectId?: string;
  status: Exclude<ProviderRuntimeStatus, null>;
  observedAt: number;
}

export interface ProviderRuntimeState {
  bySessionId: ReadonlyMap<string, ProviderRuntimeStatusRecord>;
}

export interface ClientSummaryState {
  sessions: SessionCollectionState;
  projects: ProjectCollectionState;
  projectQueues: ProjectQueueCollectionState;
  inbox: InboxCollectionState;
  localDecorations: LocalDecorationState;
  providerRuntime: ProviderRuntimeState;
}

export function resolveSessionCollectionId(
  state: Pick<ClientSummaryState, "sessions">,
  sessionId: string,
): string {
  const aliases = state.sessions.aliases;
  if (!aliases.size) return sessionId;

  let resolved = sessionId;
  const visited = new Set<string>();
  while (!visited.has(resolved)) {
    visited.add(resolved);
    const next = aliases.get(resolved);
    if (!next) break;
    resolved = next;
  }
  return resolved;
}

export interface GlobalSessionsCollectionSnapshot {
  query: SessionCollectionQueryDescriptor;
  sessions: readonly GlobalSessionItem[];
  hasMore: boolean;
  mode?: "replace" | "append" | "prepend";
}

export interface ProjectsCollectionSnapshot {
  projects: readonly Project[];
}

export interface ProjectCollectionSnapshot {
  project: Project;
}

export interface ProjectQueueCollectionSnapshot extends ProjectQueueResponse {}

export interface ProjectQueueGlobalCollectionSnapshot
  extends ProjectQueueListResponse {}

export interface InboxCollectionSnapshot extends InboxResponse {}

export interface ProviderRuntimeStatusSnapshot {
  sessionId: string;
  projectId?: string;
  providerRuntimeStatus?: ProviderRuntimeStatus;
}

export const ALL_PROJECTS_QUERY_KEY = "all-projects";
export const EMPTY_PROJECT_QUEUE_ITEMS: readonly ProjectQueueItemSummary[] = [];
export const EMPTY_RECOVERED_SESSION_QUEUES: readonly ProjectQueueRecoveredSessionQueueSummary[] =
  [];
export const RUNNING_PROJECT_QUEUE_DISPATCH_STATE: ProjectQueueDispatchState = {
  status: "running",
};
