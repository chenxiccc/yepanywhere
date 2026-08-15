import {
  PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
  PUBLIC_SHARE_LEGACY_RELAY_BODY_MAX_BYTES,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  isPublicShareSessionTransferSizeWithinLimits,
  type AppSession,
  type FreezePublicSessionLiveSharesResponse,
  type PublicShareSessionChunksMetadata,
  type PublicSessionShareMetadata,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareMode,
  type PublicSessionShareResponse,
  type PublicSessionShareSessionStatusResponse,
  type PublicSessionShareViewerActionResponse,
  type PublicSessionShareViewerSummary,
  type RevokePublicSessionSharesResponse,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createLruSet, refreshLruSet } from "../lib/lruCollections.js";
import {
  type PublicShareGrant,
  type PublicShareLinkedFileMode,
  type PublicSharePresentation,
  type PublicShareRepresentationAvailability,
  type PublicShareStoredCapture,
  type PublicShareStoreReadiness,
  PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES,
  PublicShareStore,
  digestStoredSessionProjection,
  getPublicShareViewerSnapshot,
} from "./PublicShareStore.js";

export const LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES =
  PUBLIC_SHARE_LEGACY_RELAY_BODY_MAX_BYTES;
export const LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES =
  PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES;
export const PUBLIC_SHARE_SECRET_BYTES = 16;
export const PUBLIC_SHARE_SECRET_BITS = PUBLIC_SHARE_SECRET_BYTES * 8;
export const LEGACY_PUBLIC_SHARE_SECRET_BYTES = 64;
const PUBLIC_SHARE_VIEWER_TTL_MS = 120_000;
const PUBLIC_SHARE_VIEWER_UPDATE_GRACE_MS = 30_000;
const PUBLIC_SHARE_VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;
const PUBLIC_SHARE_CHUNK_CURSOR_BYTES = 8 + 32;
export const PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES = 4_096;

export type PublicShareRecord = PublicShareGrant;

interface ViewerTelemetryRecord {
  secretHash: string;
  viewerId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  accessCount: number;
}

interface PublicShareStatusOptions {
  sessionUpdatedAt?: string | null;
}

export type PublicShareCaptureErrorCode =
  | "incomplete-history"
  | "source-changed";

export class PublicShareCaptureError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly code: PublicShareCaptureErrorCode,
  ) {
    super(message);
    this.name = "PublicShareCaptureError";
  }
}

export class PublicShareChunkCursorError extends Error {
  constructor() {
    super("Share chunk cursor is no longer valid");
    this.name = "PublicShareChunkCursorError";
  }
}

export interface PublicShareSessionChunk {
  bytes: Buffer;
  cursor: string | null;
  final: boolean;
  index: number;
  offset: number;
  nextOffset: number;
  metadata: PublicShareSessionChunksMetadata;
}

export interface PublicShareCapture extends PublicShareStoredCapture {}

export type LoadCompletePublicShareSession = () => Promise<AppSession | null>;

export interface PublicShareServiceOptions {
  dataDir: string;
}

export interface CreatePublicShareOptions {
  mode: PublicSessionShareMode;
  source: PublicShareRecord["source"];
  title?: string | null;
  initialPrompt?: string | null;
  capture?: PublicShareCapture;
  buildPublicUrl?: (secret: string) => string;
}

function normalizeGrantText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function hashSecret(secret: string): string {
  return createHash("sha512").update(secret, "utf8").digest("base64url");
}

function isValidSecret(secret: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    return false;
  }
  try {
    const byteLength = Buffer.from(secret, "base64url").length;
    return (
      byteLength === PUBLIC_SHARE_SECRET_BYTES ||
      byteLength === LEGACY_PUBLIC_SHARE_SECRET_BYTES
    );
  } catch {
    return false;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

function sanitizeSessionForPublicShare(session: AppSession): AppSession {
  const {
    pendingInputType: _pendingInputType,
    activity: _activity,
    lastSeenAt: _lastSeenAt,
    hasUnread: _hasUnread,
    heartbeatTurnsEnabled: _heartbeatTurnsEnabled,
    heartbeatTurnsAfterMinutes: _heartbeatTurnsAfterMinutes,
    heartbeatTurnText: _heartbeatTurnText,
    transcriptDisplayObjects: _transcriptDisplayObjects,
    ...rest
  } = session as AppSession & {
    heartbeatTurnsEnabled?: boolean;
    heartbeatTurnsAfterMinutes?: number;
    heartbeatTurnText?: string;
  };

  return {
    ...rest,
    ownership: { owner: "none" },
    messages: Array.isArray(session.messages) ? session.messages : [],
  };
}

function freezeSessionProjection(session: AppSession): AppSession {
  const pending: object[] = [session];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") pending.push(value);
    }
    Object.freeze(current);
  }
  return session;
}

function prepareCompleteSessionProjection(session: AppSession): AppSession {
  if (
    !Array.isArray(session.messages) ||
    (session.messageCount > 0 && session.messages.length === 0)
  ) {
    throw new PublicShareCaptureError(
      "Complete session history is unavailable; retry frozen capture",
      "incomplete-history",
    );
  }
  return freezeSessionProjection(sanitizeSessionForPublicShare(session));
}

function toPublicResponse(
  record: PublicShareRecord,
  session: AppSession,
  options?: { capturedAt?: string; linkedFileMode?: PublicShareLinkedFileMode },
): PublicSessionShareResponse {
  const share: PublicSessionShareMetadata = {
    mode: options?.capturedAt ? "frozen" : record.mode,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: session.updatedAt,
    capturedAt: options?.capturedAt ?? record.capturedAt,
    linkedFileMode: options?.linkedFileMode ?? record.linkedFileMode,
    source: record.source,
  };

  return {
    share,
    session,
  };
}

function matchesSession(
  record: PublicShareRecord,
  projectId: UrlProjectId,
  sessionId: string,
): boolean {
  return (
    record.source.projectId === projectId &&
    record.source.sessionId === sessionId
  );
}

function minIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function parseIsoTime(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isViewerActiveForStatus(
  lastSeenAt: number,
  now: number,
  options: PublicShareStatusOptions,
): boolean {
  if (now - lastSeenAt > PUBLIC_SHARE_VIEWER_TTL_MS) {
    return false;
  }
  const sessionUpdatedAt = parseIsoTime(options.sessionUpdatedAt);
  if (sessionUpdatedAt === null) {
    return true;
  }
  if (now <= sessionUpdatedAt + PUBLIC_SHARE_VIEWER_UPDATE_GRACE_MS) {
    return true;
  }
  return lastSeenAt >= sessionUpdatedAt;
}

function summarizeRecords(
  records: PublicShareRecord[],
): PublicSessionShareSessionStatusResponse {
  let frozenCount = 0;
  let liveCount = 0;
  for (const record of records) {
    if (record.mode === "frozen") {
      frozenCount += 1;
    } else {
      liveCount += 1;
    }
  }
  return {
    activeCount: frozenCount + liveCount,
    frozenCount,
    liveCount,
    activeViewerCount: 0,
    viewers: [],
  };
}

export class PublicShareService {
  private readonly store: PublicShareStore;
  private readonly viewerTelemetry = new Map<
    string,
    Map<string, ViewerTelemetryRecord>
  >();
  private readonly viewerTelemetryByRecency =
    createLruSet<ViewerTelemetryRecord>();

  constructor(options: PublicShareServiceOptions) {
    this.store = new PublicShareStore(options.dataDir);
  }

  async initialize(enabled = true): Promise<void> {
    await this.store.initialize(enabled);
    console.log(
      `[public-shares] Loaded ${this.store.getAllGrants().length} grant(s)`,
    );
  }

  async disableAndRevoke(): Promise<number> {
    const revokedCount = await this.store.disable();
    this.viewerTelemetry.clear();
    this.viewerTelemetryByRecency.clear();
    return revokedCount;
  }

  async enable(): Promise<void> {
    await this.store.enable();
  }

  getReadiness(): { state: PublicShareStoreReadiness; error: string | null } {
    return this.store.getReadiness();
  }

  getValidShareCount(): number {
    return this.store.getAllGrants().length;
  }

  isCleanupPending(): boolean {
    return this.store.isCleanupPending();
  }

  getAllRecords(): PublicShareRecord[] {
    return this.store.getAllGrants();
  }

  hasViewerSnapshot(record: PublicShareRecord, viewerId: string): boolean {
    return getPublicShareViewerSnapshot(record, viewerId) !== undefined;
  }

  getSelectedRepresentationAvailability(
    record: PublicShareRecord,
    viewerId?: string,
  ): PublicShareRepresentationAvailability {
    const viewerSnapshot = getPublicShareViewerSnapshot(record, viewerId);
    if (viewerSnapshot) {
      return viewerSnapshot.availability ?? "available";
    }
    if (record.primaryAvailability) {
      return record.primaryAvailability;
    }
    if (record.mode === "live") {
      return "available";
    }
    return record.repairRequired ? "repair-required" : "available";
  }

  getPublicMetadata(
    record: PublicShareRecord,
    viewerId?: string,
  ): PublicSessionSharePublicMetadata {
    const viewerSnapshot = getPublicShareViewerSnapshot(record, viewerId);
    return {
      mode: viewerSnapshot ? "frozen" : record.mode,
      title: record.title,
      initialPrompt: record.initialPrompt,
      projectName: record.source.projectName ?? null,
      provider: record.source.provider,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      capturedAt: viewerSnapshot?.capturedAt ?? record.capturedAt,
      linkedFileMode: viewerSnapshot?.linkedFileMode ?? record.linkedFileMode,
    };
  }

  async getFrozenSessionChunksMetadata(
    record: PublicShareRecord,
    viewerId?: string,
  ): Promise<PublicShareSessionChunksMetadata | null> {
    const selection = this.getSelectedFrozenRevision(record, viewerId);
    if (!selection) return null;
    const descriptor = await this.store.getRevisionDescriptor(
      record,
      selection.revisionId,
    );
    if (!descriptor) return null;
    if (
      descriptor.linkedFileMode !== selection.linkedFileMode ||
      descriptor.snapshotBytes !== selection.snapshotBytes
    ) {
      throw new Error("Public share selected revision metadata mismatch");
    }
    if (
      !isPublicShareSessionTransferSizeWithinLimits(
        descriptor.compressedBytes,
        descriptor.snapshotBytes,
      )
    ) {
      return null;
    }
    return {
      revisionId: descriptor.revisionId,
      integrityWitness: descriptor.integrityWitness,
      compressedBytes: descriptor.compressedBytes,
      sessionBytes: descriptor.snapshotBytes,
      maxChunkBytes: PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      capturedAt: selection.capturedAt,
      linkedFileMode: descriptor.linkedFileMode,
    };
  }

  async getFrozenSessionChunk(
    record: PublicShareRecord,
    viewerId?: string,
    cursor?: string,
  ): Promise<PublicShareSessionChunk | null> {
    const metadata = await this.getFrozenSessionChunksMetadata(
      record,
      viewerId,
    );
    if (!metadata) return null;
    const selectedViewerId =
      viewerId && this.hasViewerSnapshot(record, viewerId)
        ? viewerId
        : undefined;
    const offset = cursor
      ? this.decodeChunkCursor(
          record,
          selectedViewerId,
          metadata.revisionId,
          metadata.capturedAt,
          cursor,
        )
      : 0;
    const chunk = await this.store.readRevisionCompressedChunk(
      record,
      metadata.revisionId,
      offset,
      PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
    );
    if (
      chunk.descriptor.integrityWitness !== metadata.integrityWitness ||
      chunk.descriptor.compressedBytes !== metadata.compressedBytes ||
      chunk.descriptor.snapshotBytes !== metadata.sessionBytes
    ) {
      throw new PublicShareChunkCursorError();
    }
    return {
      bytes: chunk.bytes,
      cursor: chunk.final
        ? null
        : this.encodeChunkCursor(
            record,
            selectedViewerId,
            metadata.revisionId,
            metadata.capturedAt,
            chunk.nextOffset,
          ),
      final: chunk.final,
      index: Math.floor(offset / PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
      offset: chunk.offset,
      nextOffset: chunk.nextOffset,
      metadata,
    };
  }

  async revokeShare(shareId: string): Promise<boolean> {
    const revoked = await this.store.revokeMatching(
      (record) => record.shareId === shareId,
    );
    for (const record of revoked) {
      this.removeViewerTelemetryForSecret(record.secretHash);
    }
    return revoked.length > 0;
  }

  async captureCompleteSession(
    loadCompleteSession: LoadCompletePublicShareSession,
  ): Promise<PublicShareCapture | null> {
    const session = await loadCompleteSession();
    if (!session) return null;
    const snapshot = prepareCompleteSessionProjection(session);
    const sourceRevision = await digestStoredSessionProjection(snapshot);

    return {
      snapshot,
      sourceRevision,
      validateBeforeAuthority: async () => {
        const currentSession = await loadCompleteSession();
        if (!currentSession) {
          throw new PublicShareCaptureError(
            "Session became unavailable during frozen capture; retry",
            "source-changed",
          );
        }
        const currentProjection =
          prepareCompleteSessionProjection(currentSession);
        if (currentProjection.messages.length < snapshot.messages.length) {
          throw new PublicShareCaptureError(
            "Session history moved behind the frozen capture boundary; retry",
            "source-changed",
          );
        }
        const currentRevision = await digestStoredSessionProjection({
          ...snapshot,
          messages: currentProjection.messages.slice(
            0,
            snapshot.messages.length,
          ),
        });
        if (currentRevision !== sourceRevision) {
          throw new PublicShareCaptureError(
            "Session changed before the frozen capture boundary; retry",
            "source-changed",
          );
        }
      },
    };
  }

  async createShare(options: CreatePublicShareOptions): Promise<{
    secret: string;
    secretBits: number;
    record: PublicShareRecord;
  }> {
    if (options.mode === "frozen" && !options.capture) {
      throw new Error("Frozen shares require a complete session capture");
    }

    const secret = randomBytes(PUBLIC_SHARE_SECRET_BYTES).toString("base64url");
    const secretHash = hashSecret(secret);
    const publicUrl = options.buildPublicUrl?.(secret);
    const { grant: record } = await this.store.createGrant({
      secretHash,
      ...(publicUrl ? { publicUrl } : {}),
      mode: options.mode,
      title: normalizeGrantText(options.title, PUBLIC_SHARE_TITLE_MAX_LENGTH),
      initialPrompt: normalizeGrantText(
        options.initialPrompt,
        PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
      ),
      source: options.source,
      ...(options.capture ? { capture: options.capture } : {}),
    });

    return {
      secret,
      secretBits: PUBLIC_SHARE_SECRET_BITS,
      record,
    };
  }

  async getFrozenShareBySecret(
    secret: string,
  ): Promise<PublicSessionShareResponse | null> {
    const record = this.getRecordBySecret(secret);
    if (record?.mode !== "frozen" || !record.revisionId) {
      return null;
    }
    const session = await this.store.readRevisionSession(
      record,
      record.revisionId,
    );
    return toPublicResponse(record, session);
  }

  getRecordBySecret(secret: string): PublicShareRecord | null {
    if (!isValidSecret(secret)) {
      return null;
    }
    const secretHash = hashSecret(secret);
    const record = this.store.getGrantBySecretHash(secretHash);
    return record && timingSafeStringEqual(record.secretHash, secretHash)
      ? record
      : null;
  }

  getSessionShareStatus(
    projectId: UrlProjectId,
    sessionId: string,
    options: PublicShareStatusOptions = {},
  ): PublicSessionShareSessionStatusResponse {
    const records = this.store
      .getAllGrants()
      .filter((record) => matchesSession(record, projectId, sessionId));
    return {
      ...summarizeRecords(records),
      activeViewerCount: this.countViewersForRecords(records, options),
      viewers: this.summarizeViewersForRecords(records, options),
    };
  }

  async revokeSessionShares(
    projectId: UrlProjectId,
    sessionId: string,
  ): Promise<RevokePublicSessionSharesResponse> {
    const revokedRecords = await this.store.revokeMatching((record) =>
      matchesSession(record, projectId, sessionId),
    );
    for (const record of revokedRecords) {
      this.removeViewerTelemetryForSecret(record.secretHash);
    }
    return {
      revokedCount: revokedRecords.length,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async revokeAllShares(): Promise<number> {
    const revokedRecords = await this.store.revokeMatching(() => true);
    this.viewerTelemetry.clear();
    this.viewerTelemetryByRecency.clear();
    return revokedRecords.length;
  }

  async freezeSessionLiveShares(
    projectId: UrlProjectId,
    sessionId: string,
    capture: PublicShareCapture,
  ): Promise<FreezePublicSessionLiveSharesResponse> {
    const converted = await this.store.freezeMatching({
      matches: (record) => matchesSession(record, projectId, sessionId),
      capture,
    });
    return {
      convertedCount: converted.length,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async freezeLiveSharesById(
    shareIds: ReadonlySet<string>,
    capture: PublicShareCapture,
  ): Promise<number> {
    const converted = await this.store.freezeMatching({
      matches: (record) => shareIds.has(record.shareId),
      capture,
    });
    return converted.length;
  }

  canFreezeSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): boolean {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) return false;
    return this.store
      .getAllGrants()
      .some(
        (record) =>
          record.mode === "live" &&
          matchesSession(record, projectId, sessionId) &&
          !this.isViewerDisconnected(record, viewerId),
      );
  }

  getSessionViewerFreezeStatus(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): PublicSessionShareViewerActionResponse {
    return {
      viewerId,
      convertedCount: 0,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async freezeSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
    capture: PublicShareCapture,
  ): Promise<PublicSessionShareViewerActionResponse> {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return this.getSessionViewerFreezeStatus(projectId, sessionId, viewerId);
    }

    const converted = await this.store.freezeMatching({
      matches: (record) =>
        matchesSession(record, projectId, sessionId) &&
        !this.isViewerDisconnected(record, viewerId),
      capture,
      viewerId,
    });
    if (converted.length > 0) {
      this.removeViewerTelemetryForSession(projectId, sessionId, viewerId);
    }
    return {
      viewerId,
      convertedCount: converted.length,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async disconnectSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): Promise<PublicSessionShareViewerActionResponse> {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return {
        viewerId,
        ...this.getSessionShareStatus(projectId, sessionId),
      };
    }

    const changed = await this.store.disconnectViewer(
      (record) => matchesSession(record, projectId, sessionId),
      viewerId,
    );
    if (changed) {
      this.removeViewerTelemetryForSession(projectId, sessionId, viewerId);
    }
    return {
      viewerId,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  buildLiveResponse(
    record: PublicShareRecord,
    session: AppSession,
  ): PublicSessionShareResponse {
    const sanitizedSession = sanitizeSessionForPublicShare(session);
    return {
      share: {
        mode: record.mode,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: sanitizedSession.updatedAt,
        activeViewerCount: this.getActiveViewerCount(record),
        capturedAt: record.capturedAt,
        source: {
          ...record.source,
          provider: sanitizedSession.provider,
        },
      },
      session: sanitizedSession,
    };
  }

  async getViewerSnapshotResponse(
    record: PublicShareRecord,
    viewerId: string,
  ): Promise<PublicSessionShareResponse | null> {
    const snapshot = getPublicShareViewerSnapshot(record, viewerId);
    if (!snapshot?.revisionId || !snapshot.linkedFileMode) {
      return null;
    }
    const session = await this.store.readRevisionSession(
      record,
      snapshot.revisionId,
    );
    const response = toPublicResponse(record, session, snapshot);
    response.share.activeViewerCount = this.getActiveViewerCount(record);
    return response;
  }

  async getFrozenSessionJsonChunks(
    record: PublicShareRecord,
    viewerId?: string,
  ): Promise<{
    capturedAt: string;
    linkedFileMode: PublicShareLinkedFileMode;
    revisionId: string;
    chunks: AsyncIterable<Uint8Array>;
  } | null> {
    const viewerSnapshot = getPublicShareViewerSnapshot(record, viewerId);
    const revisionId = viewerSnapshot
      ? viewerSnapshot.revisionId
      : record.revisionId;
    const capturedAt = viewerSnapshot
      ? viewerSnapshot.capturedAt
      : record.capturedAt;
    const linkedFileMode = viewerSnapshot
      ? viewerSnapshot.linkedFileMode
      : record.linkedFileMode;
    if (!revisionId || !capturedAt || !linkedFileMode) return null;
    return {
      revisionId,
      capturedAt,
      linkedFileMode,
      chunks: await this.store.getRevisionSessionChunks(record, revisionId),
    };
  }

  async getFrozenPresentation(
    record: PublicShareRecord,
    viewerId?: string,
  ): Promise<PublicSharePresentation | null> {
    const snapshot = getPublicShareViewerSnapshot(record, viewerId);
    const revisionId = snapshot ? snapshot.revisionId : record.revisionId;
    return revisionId
      ? await this.store.readPresentation(record, revisionId)
      : null;
  }

  async getFrozenProjectRoot(
    record: PublicShareRecord,
    viewerId?: string,
  ): Promise<string | null> {
    const snapshot = getPublicShareViewerSnapshot(record, viewerId);
    const revisionId = snapshot ? snapshot.revisionId : record.revisionId;
    const linkedFileMode = snapshot
      ? snapshot.linkedFileMode
      : record.linkedFileMode;
    return revisionId && linkedFileMode === "cow"
      ? await this.store.getRevisionProjectRoot(record, revisionId)
      : null;
  }

  isViewerDisconnected(record: PublicShareRecord, viewerId: string): boolean {
    return record.disconnectedViewerIds?.includes(viewerId) ?? false;
  }

  private getSelectedFrozenRevision(
    record: PublicShareRecord,
    viewerId?: string,
  ): {
    capturedAt: string;
    linkedFileMode: PublicShareLinkedFileMode;
    revisionId: string;
    snapshotBytes: number;
  } | null {
    const viewerSnapshot = getPublicShareViewerSnapshot(record, viewerId);
    if (viewerSnapshot) {
      return viewerSnapshot.revisionId && viewerSnapshot.linkedFileMode
        ? {
            capturedAt: viewerSnapshot.capturedAt,
            linkedFileMode: viewerSnapshot.linkedFileMode,
            revisionId: viewerSnapshot.revisionId,
            snapshotBytes: viewerSnapshot.snapshotBytes,
          }
        : null;
    }
    if (
      record.mode !== "frozen" ||
      !record.revisionId ||
      !record.capturedAt ||
      !record.linkedFileMode ||
      record.snapshotBytes === undefined
    ) {
      return null;
    }
    return {
      capturedAt: record.capturedAt,
      linkedFileMode: record.linkedFileMode,
      revisionId: record.revisionId,
      snapshotBytes: record.snapshotBytes,
    };
  }

  private chunkCursorMac(
    record: PublicShareRecord,
    viewerId: string | undefined,
    revisionId: string,
    capturedAt: string,
    offsetBytes: Buffer,
  ): Buffer {
    return createHmac("sha256", Buffer.from(record.secretHash, "base64url"))
      .update("public-share-session-chunk\0")
      .update(record.shareId)
      .update("\0")
      .update(record.shareStateId)
      .update("\0")
      .update(viewerId ?? "primary")
      .update("\0")
      .update(revisionId)
      .update("\0")
      .update(capturedAt)
      .update("\0")
      .update(offsetBytes)
      .digest();
  }

  private encodeChunkCursor(
    record: PublicShareRecord,
    viewerId: string | undefined,
    revisionId: string,
    capturedAt: string,
    offset: number,
  ): string {
    const offsetBytes = Buffer.alloc(8);
    offsetBytes.writeBigUInt64BE(BigInt(offset));
    return Buffer.concat([
      offsetBytes,
      this.chunkCursorMac(
        record,
        viewerId,
        revisionId,
        capturedAt,
        offsetBytes,
      ),
    ]).toString("base64url");
  }

  private decodeChunkCursor(
    record: PublicShareRecord,
    viewerId: string | undefined,
    revisionId: string,
    capturedAt: string,
    cursor: string,
  ): number {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new PublicShareChunkCursorError();
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (
      decoded.length !== PUBLIC_SHARE_CHUNK_CURSOR_BYTES ||
      decoded.toString("base64url") !== cursor
    ) {
      throw new PublicShareChunkCursorError();
    }
    const offsetBytes = decoded.subarray(0, 8);
    const suppliedMac = decoded.subarray(8);
    const expectedMac = this.chunkCursorMac(
      record,
      viewerId,
      revisionId,
      capturedAt,
      offsetBytes,
    );
    if (!timingSafeEqual(suppliedMac, expectedMac)) {
      throw new PublicShareChunkCursorError();
    }
    const offset = offsetBytes.readBigUInt64BE();
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PublicShareChunkCursorError();
    }
    return Number(offset);
  }

  recordViewerHeartbeat(record: PublicShareRecord, viewerId: string): number {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return this.getActiveViewerCount(record);
    }
    if (this.isViewerDisconnected(record, viewerId)) {
      this.removeViewerTelemetry(record.secretHash, viewerId);
      return this.getActiveViewerCount(record);
    }

    const now = Date.now();
    this.pruneViewerTelemetry(now);
    let viewers = this.viewerTelemetry.get(record.secretHash);
    if (!viewers) {
      viewers = new Map();
      this.viewerTelemetry.set(record.secretHash, viewers);
    }
    let telemetry = viewers.get(viewerId);
    if (telemetry) {
      telemetry.lastSeenAt = now;
      telemetry.accessCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        telemetry.accessCount + 1,
      );
    } else {
      telemetry = {
        secretHash: record.secretHash,
        viewerId,
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 1,
      };
      viewers.set(viewerId, telemetry);
    }
    refreshLruSet(this.viewerTelemetryByRecency, telemetry);
    this.evictViewerTelemetryOverLimit();
    return viewers.size;
  }

  getActiveViewerCount(record: PublicShareRecord): number {
    this.pruneViewerTelemetry();
    return this.viewerTelemetry.get(record.secretHash)?.size ?? 0;
  }

  private countViewersForRecords(
    records: PublicShareRecord[],
    options: PublicShareStatusOptions,
  ): number {
    const now = Date.now();
    this.pruneViewerTelemetry(now);
    let count = 0;
    for (const record of records) {
      const viewers = this.viewerTelemetry.get(record.secretHash);
      if (!viewers) continue;
      for (const telemetry of viewers.values()) {
        if (isViewerActiveForStatus(telemetry.lastSeenAt, now, options)) {
          count += 1;
        }
      }
    }
    return count;
  }

  private summarizeViewersForRecords(
    records: PublicShareRecord[],
    options: PublicShareStatusOptions,
  ): PublicSessionShareViewerSummary[] {
    const now = Date.now();
    this.pruneViewerTelemetry(now);
    const byViewerId = new Map<
      string,
      Omit<PublicSessionShareViewerSummary, "shortId">
    >();
    for (const record of records) {
      const viewers = this.viewerTelemetry.get(record.secretHash);
      if (!viewers) continue;
      for (const telemetry of viewers.values()) {
        if (!isViewerActiveForStatus(telemetry.lastSeenAt, now, options)) {
          continue;
        }
        const existing = byViewerId.get(telemetry.viewerId);
        const firstSeenAt = new Date(telemetry.firstSeenAt).toISOString();
        const lastSeenAt = new Date(telemetry.lastSeenAt).toISOString();
        byViewerId.set(telemetry.viewerId, {
          viewerId: telemetry.viewerId,
          firstSeenAt:
            minIso(existing?.firstSeenAt, firstSeenAt) ?? firstSeenAt,
          lastSeenAt: maxIso(existing?.lastSeenAt, lastSeenAt) ?? lastSeenAt,
          accessCount: Math.min(
            Number.MAX_SAFE_INTEGER,
            (existing?.accessCount ?? 0) + telemetry.accessCount,
          ),
          active: true,
          disconnected:
            (existing?.disconnected ?? false) ||
            this.isViewerDisconnected(record, telemetry.viewerId),
          frozen:
            (existing?.frozen ?? false) ||
            this.hasViewerSnapshot(record, telemetry.viewerId),
        });
      }
    }

    return [...byViewerId.values()]
      .map((viewer) => ({
        ...viewer,
        shortId: viewer.viewerId.slice(0, 8),
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  private removeViewerTelemetryForSession(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): void {
    for (const record of this.store.getAllGrants()) {
      if (matchesSession(record, projectId, sessionId)) {
        this.removeViewerTelemetry(record.secretHash, viewerId);
      }
    }
  }

  private removeViewerTelemetryForSecret(secretHash: string): void {
    const viewers = this.viewerTelemetry.get(secretHash);
    if (!viewers) return;
    for (const telemetry of viewers.values()) {
      this.viewerTelemetryByRecency.delete(telemetry);
    }
    this.viewerTelemetry.delete(secretHash);
  }

  private removeViewerTelemetry(secretHash: string, viewerId: string): void {
    const viewers = this.viewerTelemetry.get(secretHash);
    const telemetry = viewers?.get(viewerId);
    if (!viewers || !telemetry) return;
    viewers.delete(viewerId);
    this.viewerTelemetryByRecency.delete(telemetry);
    if (viewers.size === 0) {
      this.viewerTelemetry.delete(secretHash);
    }
  }

  private pruneViewerTelemetry(now = Date.now()): void {
    const cutoff = now - PUBLIC_SHARE_VIEWER_TTL_MS;
    while (true) {
      const oldest = this.viewerTelemetryByRecency.values().next().value;
      if (!oldest || oldest.lastSeenAt >= cutoff) return;
      this.removeViewerTelemetry(oldest.secretHash, oldest.viewerId);
    }
  }

  private evictViewerTelemetryOverLimit(): void {
    while (
      this.viewerTelemetryByRecency.size >
      PUBLIC_SHARE_VIEWER_TELEMETRY_MAX_ENTRIES
    ) {
      const oldest = this.viewerTelemetryByRecency.values().next().value;
      if (!oldest) return;
      this.removeViewerTelemetry(oldest.secretHash, oldest.viewerId);
    }
  }
}
