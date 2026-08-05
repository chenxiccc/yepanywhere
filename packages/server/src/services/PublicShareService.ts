import type {
  AppSession,
  FreezePublicSessionLiveSharesResponse,
  PublicSessionShareMetadata,
  PublicSessionSharePublicMetadata,
  PublicSessionShareMode,
  PublicSessionShareResponse,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerActionResponse,
  PublicSessionShareViewerSummary,
  RevokePublicSessionSharesResponse,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type PublicShareGrant,
  type PublicShareLinkedFileMode,
  type PublicSharePresentation,
  type PublicShareStoreReadiness,
  PublicShareStore,
} from "./PublicShareStore.js";

export const PUBLIC_SHARE_SECRET_BYTES = 16;
export const PUBLIC_SHARE_SECRET_BITS = PUBLIC_SHARE_SECRET_BYTES * 8;
export const LEGACY_PUBLIC_SHARE_SECRET_BYTES = 64;
const PUBLIC_SHARE_VIEWER_TTL_MS = 120_000;
const PUBLIC_SHARE_VIEWER_UPDATE_GRACE_MS = 30_000;
const PUBLIC_SHARE_VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

export type PublicShareRecord = PublicShareGrant;

interface ViewerAccessRecord {
  firstSeenAt: string;
  lastSeenAt: string;
  accessCount: number;
}

interface PublicShareStatusOptions {
  sessionUpdatedAt?: string | null;
}

export interface PublicShareCaptureOptions {
  presentation?: PublicSharePresentation;
  projectRoot?: string;
}

export interface PublicShareServiceOptions {
  dataDir: string;
}

export interface CreatePublicShareOptions {
  mode: PublicSessionShareMode;
  source: PublicShareRecord["source"];
  title?: string | null;
  initialPrompt?: string | null;
  snapshot?: AppSession;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
  buildPublicUrl?: (secret: string) => string;
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
  private readonly viewerHeartbeats = new Map<string, Map<string, number>>();
  private readonly viewerAccesses = new Map<
    string,
    Map<string, ViewerAccessRecord>
  >();

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
    this.viewerHeartbeats.clear();
    this.viewerAccesses.clear();
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

  getPublicMetadata(
    record: PublicShareRecord,
  ): PublicSessionSharePublicMetadata {
    return {
      mode: record.mode,
      title: record.title,
      initialPrompt: record.initialPrompt,
      projectName: record.source.projectName ?? null,
      provider: record.source.provider,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      capturedAt: record.capturedAt,
      linkedFileMode: record.linkedFileMode,
    };
  }

  async revokeShare(shareId: string): Promise<boolean> {
    const revoked = await this.store.revokeMatching(
      (record) => record.shareId === shareId,
    );
    for (const record of revoked) {
      this.viewerHeartbeats.delete(record.secretHash);
      this.viewerAccesses.delete(record.secretHash);
    }
    return revoked.length > 0;
  }

  async createShare(options: CreatePublicShareOptions): Promise<{
    secret: string;
    secretBits: number;
    record: PublicShareRecord;
  }> {
    if (options.mode === "frozen" && !options.snapshot) {
      throw new Error("Frozen shares require a session snapshot");
    }
    if (
      options.mode === "frozen" &&
      options.snapshot &&
      options.snapshot.messageCount > 0 &&
      (!Array.isArray(options.snapshot.messages) ||
        options.snapshot.messages.length === 0)
    ) {
      throw new Error(
        "Frozen share snapshot is missing its persisted messages",
      );
    }

    const secret = randomBytes(PUBLIC_SHARE_SECRET_BYTES).toString("base64url");
    const secretHash = hashSecret(secret);
    const publicUrl = options.buildPublicUrl?.(secret);
    const { grant: record } = await this.store.createGrant({
      secretHash,
      ...(publicUrl ? { publicUrl } : {}),
      mode: options.mode,
      title: options.title ?? null,
      initialPrompt: options.initialPrompt ?? null,
      source: options.source,
      ...(options.snapshot
        ? { snapshot: sanitizeSessionForPublicShare(options.snapshot) }
        : {}),
      ...(options.presentation ? { presentation: options.presentation } : {}),
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
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
      this.viewerHeartbeats.delete(record.secretHash);
      this.viewerAccesses.delete(record.secretHash);
    }
    return {
      revokedCount: revokedRecords.length,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async revokeAllShares(): Promise<number> {
    const revokedRecords = await this.store.revokeMatching(() => true);
    this.viewerHeartbeats.clear();
    this.viewerAccesses.clear();
    return revokedRecords.length;
  }

  async freezeSessionLiveShares(
    projectId: UrlProjectId,
    sessionId: string,
    session: AppSession,
    capture: PublicShareCaptureOptions = {},
  ): Promise<FreezePublicSessionLiveSharesResponse> {
    const frozenSession = sanitizeSessionForPublicShare(session);
    const converted = await this.store.freezeMatching({
      matches: (record) => matchesSession(record, projectId, sessionId),
      snapshot: frozenSession,
      ...capture,
    });
    return {
      convertedCount: converted.length,
      ...this.getSessionShareStatus(projectId, sessionId),
    };
  }

  async freezeSessionViewerToken(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
    session: AppSession,
    capture: PublicShareCaptureOptions = {},
  ): Promise<PublicSessionShareViewerActionResponse> {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return {
        viewerId,
        convertedCount: 0,
        ...this.getSessionShareStatus(projectId, sessionId),
      };
    }

    const frozenSession = sanitizeSessionForPublicShare(session);
    const converted = await this.store.freezeMatching({
      matches: (record) =>
        matchesSession(record, projectId, sessionId) &&
        !this.isViewerDisconnected(record, viewerId),
      snapshot: frozenSession,
      viewerId,
      ...capture,
    });
    if (converted.length > 0) {
      this.removeViewerHeartbeatForSession(projectId, sessionId, viewerId);
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
      this.removeViewerHeartbeatForSession(projectId, sessionId, viewerId);
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
    const snapshot = record.viewerSnapshots?.[viewerId];
    if (!snapshot) {
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

  getFrozenSessionStream(
    record: PublicShareRecord,
    viewerId?: string,
  ): {
    capturedAt: string;
    linkedFileMode: PublicShareLinkedFileMode;
    revisionId: string;
    stream: Readable;
  } | null {
    const viewerSnapshot = viewerId
      ? record.viewerSnapshots?.[viewerId]
      : undefined;
    const revisionId = viewerSnapshot?.revisionId ?? record.revisionId;
    const capturedAt = viewerSnapshot?.capturedAt ?? record.capturedAt;
    const linkedFileMode =
      viewerSnapshot?.linkedFileMode ?? record.linkedFileMode;
    if (!revisionId || !capturedAt || !linkedFileMode) return null;
    return {
      revisionId,
      capturedAt,
      linkedFileMode,
      stream: this.store.getRevisionSessionStream(record, revisionId),
    };
  }

  async getFrozenPresentation(
    record: PublicShareRecord,
    viewerId?: string,
  ): Promise<PublicSharePresentation | null> {
    const revisionId =
      (viewerId ? record.viewerSnapshots?.[viewerId]?.revisionId : undefined) ??
      record.revisionId;
    return revisionId
      ? await this.store.readPresentation(record, revisionId)
      : null;
  }

  getFrozenProjectRoot(
    record: PublicShareRecord,
    viewerId?: string,
  ): string | null {
    const snapshot = viewerId ? record.viewerSnapshots?.[viewerId] : undefined;
    const revisionId = snapshot?.revisionId ?? record.revisionId;
    const linkedFileMode = snapshot?.linkedFileMode ?? record.linkedFileMode;
    return revisionId && linkedFileMode === "cow"
      ? this.store.getRevisionProjectRoot(record, revisionId)
      : null;
  }

  isViewerDisconnected(record: PublicShareRecord, viewerId: string): boolean {
    return record.disconnectedViewerIds?.includes(viewerId) ?? false;
  }

  recordViewerHeartbeat(record: PublicShareRecord, viewerId: string): number {
    if (!PUBLIC_SHARE_VIEWER_ID_REGEX.test(viewerId)) {
      return this.getActiveViewerCount(record);
    }
    if (this.isViewerDisconnected(record, viewerId)) {
      this.viewerHeartbeats.get(record.secretHash)?.delete(viewerId);
      return this.getActiveViewerCount(record);
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.pruneViewerHeartbeats(now);
    let viewers = this.viewerHeartbeats.get(record.secretHash);
    if (!viewers) {
      viewers = new Map();
      this.viewerHeartbeats.set(record.secretHash, viewers);
    }
    viewers.set(viewerId, now);
    let accesses = this.viewerAccesses.get(record.secretHash);
    if (!accesses) {
      accesses = new Map();
      this.viewerAccesses.set(record.secretHash, accesses);
    }
    const existing = accesses.get(viewerId);
    accesses.set(viewerId, {
      firstSeenAt: existing?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
      accessCount: (existing?.accessCount ?? 0) + 1,
    });
    return viewers.size;
  }

  getActiveViewerCount(record: PublicShareRecord): number {
    this.pruneViewerHeartbeats();
    return this.viewerHeartbeats.get(record.secretHash)?.size ?? 0;
  }

  private countViewersForRecords(
    records: PublicShareRecord[],
    options: PublicShareStatusOptions,
  ): number {
    const now = Date.now();
    this.pruneViewerHeartbeats(now);
    let count = 0;
    for (const record of records) {
      const viewers = this.viewerHeartbeats.get(record.secretHash);
      if (!viewers) continue;
      for (const lastSeenAt of viewers.values()) {
        if (isViewerActiveForStatus(lastSeenAt, now, options)) {
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
    this.pruneViewerHeartbeats(now);
    const byViewerId = new Map<
      string,
      Omit<PublicSessionShareViewerSummary, "shortId">
    >();
    for (const record of records) {
      const activeViewers = this.viewerHeartbeats.get(record.secretHash);
      const accesses = this.viewerAccesses.get(record.secretHash);
      const viewerIds = new Set<string>([
        ...(activeViewers?.keys() ?? []),
        ...(accesses?.keys() ?? []),
        ...(record.disconnectedViewerIds ?? []),
        ...Object.keys(record.viewerSnapshots ?? {}),
      ]);
      for (const viewerId of viewerIds) {
        const access = accesses?.get(viewerId);
        const lastHeartbeatAt = activeViewers?.get(viewerId);
        const active =
          typeof lastHeartbeatAt === "number" &&
          isViewerActiveForStatus(lastHeartbeatAt, now, options);
        if (!active) {
          continue;
        }
        const existing = byViewerId.get(viewerId);
        byViewerId.set(viewerId, {
          viewerId,
          firstSeenAt:
            minIso(existing?.firstSeenAt, access?.firstSeenAt) ??
            access?.firstSeenAt ??
            new Date(0).toISOString(),
          lastSeenAt:
            maxIso(existing?.lastSeenAt, access?.lastSeenAt) ??
            access?.lastSeenAt ??
            new Date(0).toISOString(),
          accessCount:
            (existing?.accessCount ?? 0) + (access?.accessCount ?? 0),
          active: (existing?.active ?? false) || active,
          disconnected:
            (existing?.disconnected ?? false) ||
            this.isViewerDisconnected(record, viewerId),
          frozen:
            (existing?.frozen ?? false) ||
            Boolean(record.viewerSnapshots?.[viewerId]),
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

  private removeViewerHeartbeatForSession(
    projectId: UrlProjectId,
    sessionId: string,
    viewerId: string,
  ): void {
    for (const record of this.store.getAllGrants()) {
      if (matchesSession(record, projectId, sessionId)) {
        this.viewerHeartbeats.get(record.secretHash)?.delete(viewerId);
      }
    }
  }

  private pruneViewerHeartbeats(now = Date.now()): void {
    const cutoff = now - PUBLIC_SHARE_VIEWER_TTL_MS;
    for (const [secretHash, viewers] of this.viewerHeartbeats) {
      for (const [viewerId, lastSeenAt] of viewers) {
        if (lastSeenAt < cutoff) {
          viewers.delete(viewerId);
        }
      }
      if (viewers.size === 0) {
        this.viewerHeartbeats.delete(secretHash);
      }
    }
    for (const [secretHash, accesses] of this.viewerAccesses) {
      for (const [viewerId, access] of accesses) {
        const lastSeenAt = Date.parse(access.lastSeenAt);
        if (Number.isNaN(lastSeenAt) || lastSeenAt < cutoff) {
          accesses.delete(viewerId);
        }
      }
      if (accesses.size === 0) {
        this.viewerAccesses.delete(secretHash);
      }
    }
  }
}
