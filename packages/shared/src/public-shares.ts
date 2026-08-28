import { isAppSession, type AppSession } from "./app-types.js";
import { isUrlProjectId, type UrlProjectId } from "./projectId.js";
import type { ProviderName } from "./types.js";

export type PublicSessionShareMode = "frozen" | "live";
export type PublicShareLinkedFileMode = "cow" | "live";
export type PublicShareStorageState =
  | "opening"
  | "migrating"
  | "ready"
  | "failed"
  | "disabled";

export const PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY =
  "public-share-session-chunks-v1";
export const PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION =
  "freeze-live-public-shares";
export const PUBLIC_SHARE_TITLE_MAX_LENGTH = 700;
export const PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH = 700;
export const PUBLIC_SHARE_LEGACY_RELAY_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES =
  4 * Math.ceil(PUBLIC_SHARE_LEGACY_RELAY_BODY_MAX_BYTES / 3) + 64 * 1024;
export const PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES = 256 * 1024;
export const PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT = Math.ceil(
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES /
    PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
);

export interface PublicShareSessionChunksMetadata {
  revisionId: string;
  integrityWitness: string;
  compressedBytes: number;
  sessionBytes: number;
  maxChunkBytes: number;
  capturedAt: string;
  linkedFileMode: PublicShareLinkedFileMode;
}

export interface CreatePublicSessionShareRequest {
  projectId: UrlProjectId;
  sessionId: string;
  mode: PublicSessionShareMode;
  title?: string;
  initialPrompt?: string;
}

export interface CreatePublicSessionShareResponse {
  url: string;
  shareId?: string;
  mode: PublicSessionShareMode;
  createdAt: string;
  secretBits: number;
  linkedFileMode?: PublicShareLinkedFileMode;
}

export interface CreatePublicFileShareRequest {
  projectId: UrlProjectId;
  path: string;
  title?: string;
}

export interface CreatePublicFileShareResponse {
  url: string;
  shareId: string;
  createdAt: string;
  secretBits: number;
}

export interface PublicFileShareManagementItem {
  shareId: string;
  url: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicFileShareListResponse {
  items: PublicFileShareManagementItem[];
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
  capabilities?: string[];
  sessionChunks?: PublicShareSessionChunksMetadata;
}

export interface PublicShareManagementItem {
  shareId: string;
  url?: string;
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

export interface FreezePublicSharesResponse {
  convertedCount: number;
  cleanupPending?: boolean;
}

export interface PublicSessionShareResponse {
  share: PublicSessionShareMetadata;
  session: AppSession;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalLinkedFileMode(
  value: unknown,
): value is PublicShareLinkedFileMode | undefined {
  return value === undefined || value === "cow" || value === "live";
}

export function isPublicShareSessionTransferSizeWithinLimits(
  compressedBytes: number,
  sessionBytes: number,
): boolean {
  return (
    Number.isSafeInteger(compressedBytes) &&
    compressedBytes > 0 &&
    compressedBytes <= PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES &&
    Number.isSafeInteger(sessionBytes) &&
    sessionBytes >= 0 &&
    sessionBytes <= PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES
  );
}

export function isPublicShareSessionChunksMetadata(
  value: unknown,
): value is PublicShareSessionChunksMetadata {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.revisionId === "string" &&
    value.revisionId.length > 0 &&
    typeof value.integrityWitness === "string" &&
    value.integrityWitness.length > 0 &&
    typeof value.compressedBytes === "number" &&
    typeof value.sessionBytes === "number" &&
    isPublicShareSessionTransferSizeWithinLimits(
      value.compressedBytes,
      value.sessionBytes,
    ) &&
    value.maxChunkBytes === PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES &&
    typeof value.capturedAt === "string" &&
    (value.linkedFileMode === "cow" || value.linkedFileMode === "live")
  );
}

export function isPublicSessionSharePublicMetadata(
  value: unknown,
): value is PublicSessionSharePublicMetadata {
  if (!isUnknownRecord(value)) return false;
  if (
    (value.mode !== "frozen" && value.mode !== "live") ||
    (value.title !== null && typeof value.title !== "string") ||
    (value.initialPrompt !== null && typeof value.initialPrompt !== "string") ||
    (value.projectName !== null && typeof value.projectName !== "string") ||
    !isOptionalString(value, "provider") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isOptionalString(value, "capturedAt") ||
    !isOptionalLinkedFileMode(value.linkedFileMode) ||
    (value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) ||
        !value.capabilities.every((entry) => typeof entry === "string"))) ||
    (value.sessionChunks !== undefined &&
      !isPublicShareSessionChunksMetadata(value.sessionChunks))
  ) {
    return false;
  }
  return (
    !value.capabilities?.includes(PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY) ||
    isPublicShareSessionChunksMetadata(value.sessionChunks)
  );
}

export function isPublicSessionShareMetadata(
  value: unknown,
): value is PublicSessionShareMetadata {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.source)) return false;
  return (
    (value.mode === "frozen" || value.mode === "live") &&
    (value.title === null || typeof value.title === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.activeViewerCount === undefined ||
      (typeof value.activeViewerCount === "number" &&
        Number.isSafeInteger(value.activeViewerCount) &&
        value.activeViewerCount >= 0)) &&
    isOptionalString(value, "capturedAt") &&
    isOptionalLinkedFileMode(value.linkedFileMode) &&
    typeof value.source.projectId === "string" &&
    isUrlProjectId(value.source.projectId) &&
    typeof value.source.sessionId === "string" &&
    isOptionalString(value.source, "projectName") &&
    isOptionalString(value.source, "provider")
  );
}

export function isPublicSessionShareResponse(
  value: unknown,
): value is PublicSessionShareResponse {
  if (
    !isUnknownRecord(value) ||
    !isPublicSessionShareMetadata(value.share) ||
    !isAppSession(value.session)
  ) {
    return false;
  }
  return (
    value.share.source.projectId === value.session.projectId &&
    value.share.source.sessionId === value.session.id
  );
}
