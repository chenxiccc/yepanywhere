import type { AppSession } from "./app-types.js";
import type { UrlProjectId } from "./projectId.js";
import type { ProviderName } from "./types.js";

export type PublicSessionShareMode = "frozen" | "live";
export type PublicShareLinkedFileMode = "cow" | "live";
export type PublicShareStorageState =
  | "opening"
  | "migrating"
  | "ready"
  | "failed"
  | "disabled";

export interface CreatePublicSessionShareRequest {
  projectId: UrlProjectId;
  sessionId: string;
  mode: PublicSessionShareMode;
  title?: string;
  initialPrompt?: string;
}

export interface CreatePublicSessionShareResponse {
  url: string;
  mode: PublicSessionShareMode;
  createdAt: string;
  secretBits: number;
  linkedFileMode?: PublicShareLinkedFileMode;
}

export interface PublicSessionShareSessionStatusResponse {
  storageState?: PublicShareStorageState;
  storageError?: string | null;
  activeCount: number;
  frozenCount: number;
  liveCount: number;
  activeViewerCount: number;
  viewers: PublicSessionShareViewerSummary[];
}

export interface RevokePublicSessionSharesResponse
  extends PublicSessionShareSessionStatusResponse {
  revokedCount: number;
}

export interface FreezePublicSessionLiveSharesResponse
  extends PublicSessionShareSessionStatusResponse {
  convertedCount: number;
}

export interface PublicSessionShareViewerActionResponse
  extends PublicSessionShareSessionStatusResponse {
  viewerId: string;
  convertedCount?: number;
}

export interface PublicSessionShareViewerSummary {
  viewerId: string;
  shortId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  accessCount: number;
  active: boolean;
  disconnected: boolean;
  frozen: boolean;
}

export interface PublicSessionShareMetadata {
  mode: PublicSessionShareMode;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  activeViewerCount?: number;
  capturedAt?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  source: {
    projectId: UrlProjectId;
    sessionId: string;
    projectName?: string;
    provider?: ProviderName;
  };
}

export interface PublicSessionSharePublicMetadata {
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  projectName: string | null;
  provider?: ProviderName;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
}

export interface PublicShareManagementItem {
  shareId: string;
  mode: PublicSessionShareMode;
  title: string | null;
  projectName: string | null;
  sessionId: string;
  provider?: ProviderName;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  snapshotBytes?: number;
  activeViewerCount: number;
  hasViewerSnapshots: boolean;
}

export interface PublicShareManagementListResponse {
  items: PublicShareManagementItem[];
  nextCursor: string | null;
  totalCount: number;
}

export interface RevokePublicShareResponse {
  revoked: boolean;
  cleanupPending?: boolean;
}

export interface RevokeAllPublicSharesResponse {
  revokedCount: number;
  cleanupPending?: boolean;
}

export interface PublicSessionShareResponse {
  share: PublicSessionShareMetadata;
  session: AppSession;
}
