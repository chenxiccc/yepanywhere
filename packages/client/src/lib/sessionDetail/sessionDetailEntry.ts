import type { ClientSummarySourceKey } from "../clientSummaryStore";
import type { SessionRouteScrollSnapshot } from "../sessionRouteSnapshots";
import { cloneScrollSnapshot } from "./sessionDetailSnapshots";
import {
  estimateSessionDetailStateBytes,
  type EstimateStateBytesOptions,
} from "./transcriptCharge";
import { createInitialSessionDetailState } from "./transcriptReducer";
import type { SessionDetailState } from "./types";
import type { SessionDetailEntryKeyInput } from "./sessionDetailKey";
import {
  type SessionDetailEquality,
  SessionDetailEntryStore,
  type SessionDetailSelector,
} from "./sessionDetailEntryStore";
import {
  getSessionDetailTtlMs,
  type SessionDetailRetentionOptions,
} from "./sessionDetailRetention";

export interface SessionDetailMemoryCacheEntryStats {
  key: string;
  sourceKey: ClientSummarySourceKey;
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
  messageCount: number;
  agentEntryCount: number;
  approxBytes: number;
  retainCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  hasScrollSnapshot: boolean;
}

export type SessionDetailStoreEntryStats = SessionDetailMemoryCacheEntryStats;

interface SessionDetailEntryMetadata {
  retainCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  approxBytes: number;
}

export class SessionDetailEntry {
  private metadata: SessionDetailEntryMetadata | null = null;
  private scrollSnapshotValue: SessionRouteScrollSnapshot | undefined;
  private readonly store = new SessionDetailEntryStore();

  constructor(
    readonly key: string,
    readonly input: SessionDetailEntryKeyInput,
  ) {}

  get hasRecord(): boolean {
    return this.metadata !== null;
  }

  get hasSubscriptions(): boolean {
    return this.store.hasSubscriptions;
  }

  get state(): SessionDetailState | undefined {
    return this.metadata ? this.store.state : undefined;
  }

  get retainCount(): number {
    return this.metadata?.retainCount ?? 0;
  }

  get approxBytes(): number {
    return this.metadata?.approxBytes ?? 0;
  }

  /**
   * Stored snapshots are cloned on the way in and treated as immutable, so
   * reads return the same reference until the next write — render-path
   * consumers rely on that identity stability (MessageList memo).
   */
  get scrollSnapshot(): SessionRouteScrollSnapshot | undefined {
    return this.scrollSnapshotValue;
  }

  get lastAccessedAt(): number {
    return this.metadata?.lastAccessedAt ?? 0;
  }

  markAccessed(at: number): void {
    if (this.metadata) {
      this.metadata.lastAccessedAt = at;
    }
  }

  ensureRecord(
    at: number,
    options: SessionDetailRetentionOptions,
  ): SessionDetailEntryMetadata {
    if (!this.metadata) {
      this.metadata = {
        retainCount: 0,
        createdAt: at,
        updatedAt: at,
        lastAccessedAt: at,
        expiresAt: at + getSessionDetailTtlMs(options),
        approxBytes: 0,
      };
      this.store.initialize(createInitialSessionDetailState());
    }
    return this.metadata;
  }

  replaceState(
    state: SessionDetailState,
    at: number,
    options: SessionDetailRetentionOptions,
    approxBytes: number,
    scrollSnapshot?: SessionRouteScrollSnapshot,
  ): void {
    const existing = this.metadata;
    this.metadata = {
      retainCount: existing?.retainCount ?? 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      lastAccessedAt: at,
      expiresAt: at + getSessionDetailTtlMs(options),
      approxBytes,
    };
    this.store.replaceState(state);
    this.scrollSnapshotValue = scrollSnapshot
      ? cloneScrollSnapshot(scrollSnapshot)
      : undefined;
  }

  applyState(
    state: SessionDetailState,
    at: number,
    options: SessionDetailRetentionOptions,
    approxBytes: number,
  ): void {
    const metadata = this.ensureRecord(at, options);
    metadata.updatedAt = at;
    metadata.lastAccessedAt = at;
    metadata.expiresAt = at + getSessionDetailTtlMs(options);
    metadata.approxBytes = approxBytes;
    this.store.replaceState(state);
  }

  setScrollSnapshot(
    scrollSnapshot: SessionRouteScrollSnapshot,
    at: number,
  ): boolean {
    if (!this.metadata) {
      return false;
    }
    this.scrollSnapshotValue = cloneScrollSnapshot(scrollSnapshot);
    this.metadata.updatedAt = at;
    this.metadata.lastAccessedAt = at;
    return true;
  }

  clearScrollSnapshot(): boolean {
    if (!this.scrollSnapshotValue) {
      return false;
    }
    this.scrollSnapshotValue = undefined;
    return true;
  }

  resetState(
    at: number,
    options: Pick<SessionDetailRetentionOptions, "ttlMs">,
  ): void {
    if (!this.metadata || !this.store.resetState()) {
      return;
    }
    this.metadata.updatedAt = at;
    this.metadata.lastAccessedAt = at;
    this.metadata.expiresAt = at + getSessionDetailTtlMs(options);
    this.metadata.approxBytes = 0;
  }

  incrementRetain(at: number, options: SessionDetailRetentionOptions): void {
    const metadata = this.ensureRecord(at, options);
    metadata.retainCount += 1;
    metadata.lastAccessedAt = at;
  }

  release(at: number, options: SessionDetailRetentionOptions): void {
    if (!this.metadata) {
      return;
    }
    this.metadata.retainCount = Math.max(0, this.metadata.retainCount - 1);
    this.metadata.lastAccessedAt = at;
    this.metadata.expiresAt = at + getSessionDetailTtlMs(options);
  }

  deleteRecord(): boolean {
    if (!this.metadata) {
      return false;
    }
    this.metadata = null;
    this.scrollSnapshotValue = undefined;
    this.store.clear();
    return true;
  }

  deleteIfExpired(at: number): boolean {
    if (
      !this.metadata ||
      this.metadata.retainCount > 0 ||
      this.metadata.expiresAt > at
    ) {
      return false;
    }
    return this.deleteRecord();
  }

  subscribe<T>(
    selector: SessionDetailSelector<T>,
    listener: () => void,
    equality: SessionDetailEquality<T>,
  ): () => void {
    return this.store.subscribe(selector, listener, equality);
  }

  toStats(): SessionDetailMemoryCacheEntryStats {
    const state = this.state;
    if (!this.metadata || !state) {
      throw new Error("Cannot build stats for an empty session detail entry");
    }
    return {
      key: this.key,
      sourceKey: this.input.sourceKey,
      projectId: this.input.projectId,
      sessionId: this.input.sessionId,
      tailTurns: this.input.tailTurns,
      tailFrom: this.input.tailFrom,
      messageCount: state.messages.length,
      agentEntryCount: Object.keys(state.agentContent).length,
      approxBytes: this.metadata.approxBytes,
      retainCount: this.metadata.retainCount,
      createdAt: this.metadata.createdAt,
      updatedAt: this.metadata.updatedAt,
      lastAccessedAt: this.metadata.lastAccessedAt,
      expiresAt: this.metadata.expiresAt,
      hasScrollSnapshot: this.scrollSnapshotValue !== undefined,
    };
  }

  estimateBytes(options: EstimateStateBytesOptions): number {
    const state = this.state;
    return state ? estimateSessionDetailStateBytes(state, options) : 0;
  }
}
