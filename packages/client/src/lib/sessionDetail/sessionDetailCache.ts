import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../sessionRouteSnapshots";
import { estimateSessionDetailStateBytes } from "./transcriptCharge";
import { reduceSessionDetailState } from "./transcriptReducer";
import type { SessionDetailAction, SessionDetailState } from "./types";
import {
  SessionDetailEntry,
  type SessionDetailMemoryCacheEntryStats,
} from "./sessionDetailEntry";
import {
  getSessionDetailEntryKey,
  type SessionDetailEntryKeyInput,
} from "./sessionDetailKey";
import {
  getSessionDetailMaxBytes,
  getSessionDetailMaxEntries,
  getSessionDetailNow,
  type SessionDetailRetentionOptions,
} from "./sessionDetailRetention";
import {
  routeSnapshotToState,
  stateToRouteSnapshot,
} from "./sessionDetailSnapshots";

type Selector<T> = (state: SessionDetailState | undefined) => T;
type Equality<T> = (left: T, right: T) => boolean;

export interface SessionDetailMemoryCacheStats {
  entryCount: number;
  retainedEntryCount: number;
  warmCacheEntryCount: number;
  approxBytes: number;
  /** Aggregate with rows shared across entries charged once. */
  dedupedApproxBytes: number;
  /** Entries held by mounted or lingering session views. */
  retainedApproxBytes: number;
  /** Aggregate retained bytes with rows shared across retained entries charged once. */
  retainedDedupedApproxBytes: number;
  /** Unretained entries available only as warm route cache. */
  warmCacheApproxBytes: number;
  /** Aggregate warm-cache bytes with rows shared across warm entries charged once. */
  warmCacheDedupedApproxBytes: number;
  entries: SessionDetailMemoryCacheEntryStats[];
}

export type SessionDetailStoreStats = SessionDetailMemoryCacheStats;

// Boundary paths (loads, snapshot writes) measure every row; per-action
// dispatch estimates skip serializing not-yet-measured rows (the growing
// streaming row) and charge them a calibrated flat fallback instead.
function estimateStateBytes(
  state: SessionDetailState,
  measureUncached = true,
): number {
  return estimateSessionDetailStateBytes(state, { measureUncached });
}

function isEntryCreatingAction(action: SessionDetailAction): boolean {
  return (
    action.type === "restoreRouteSnapshot" ||
    action.type === "loadPersistedTranscript"
  );
}

export class SessionDetailCache {
  private entries = new Map<string, SessionDetailEntry>();

  read(
    input: SessionDetailEntryKeyInput,
    options: Pick<SessionDetailRetentionOptions, "nowMs"> = {},
  ): SessionDetailState | undefined {
    return this.readEntry(input, options)?.state;
  }

  readRouteSnapshot(
    input: SessionDetailEntryKeyInput,
    options: Pick<SessionDetailRetentionOptions, "nowMs"> = {},
  ): SessionRouteSnapshot | undefined {
    const entry = this.readEntry(input, options);
    return entry?.state
      ? stateToRouteSnapshot(entry.state, entry.scrollSnapshot)
      : undefined;
  }

  readScrollSnapshot(
    input: SessionDetailEntryKeyInput,
    options: Pick<SessionDetailRetentionOptions, "nowMs"> = {},
  ): SessionRouteScrollSnapshot | undefined {
    return this.readEntry(input, options)?.scrollSnapshot;
  }

  readSelected<T>(
    input: SessionDetailEntryKeyInput,
    selector: (state: SessionDetailState) => T,
    options: Pick<SessionDetailRetentionOptions, "nowMs"> = {},
  ): T | undefined {
    const state = this.read(input, options);
    return state ? selector(state) : undefined;
  }

  writeRouteSnapshot(
    input: SessionDetailEntryKeyInput,
    snapshot: SessionRouteSnapshot,
    options: SessionDetailRetentionOptions = {},
  ): boolean {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    this.evictExpired({ nowMs: at });

    const state = routeSnapshotToState(snapshot);
    const approxBytes = estimateStateBytes(state);
    if (approxBytes > getSessionDetailMaxBytes(options)) {
      const existing = this.entries.get(key);
      if (!existing || existing.retainCount === 0) {
        this.deleteRecordByKey(key);
      }
      return false;
    }

    const entry = this.getOrCreateEntry(input);
    entry.replaceState(
      state,
      at,
      options,
      approxBytes,
      snapshot.scrollSnapshot,
    );
    this.evictLeastRecentlyUsed(options);
    return true;
  }

  replaceRouteSnapshot(
    input: SessionDetailEntryKeyInput,
    snapshot: SessionRouteSnapshot,
    options: SessionDetailRetentionOptions = {},
  ): boolean {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    this.evictExpired({ nowMs: at });

    const state = routeSnapshotToState(snapshot);
    const approxBytes = estimateStateBytes(state);
    const entry = this.getOrCreateEntry(input);
    entry.replaceState(
      state,
      at,
      options,
      approxBytes,
      snapshot.scrollSnapshot,
    );
    this.evictLeastRecentlyUsed(options, new Set([key]));
    return true;
  }

  dispatch(
    input: SessionDetailEntryKeyInput,
    action: SessionDetailAction,
    options: SessionDetailRetentionOptions = {},
  ): SessionDetailState | undefined {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    // Only transcript-establishing actions may create an entry. Applying an
    // incremental action to a fabricated empty entry would present a
    // truncated transcript as canonical after eviction, so those actions
    // require the owner (a mounted hook holding retain()) to exist first.
    const existing = this.entries.get(key);
    if (!existing?.hasRecord && !isEntryCreatingAction(action)) {
      if (import.meta.env.DEV) {
        console.warn("[SessionDetailStore] dropped action for missing entry", {
          key,
          actionType: action.type,
        });
      }
      return undefined;
    }
    const entry = existing?.hasRecord
      ? existing
      : this.ensureEntry(input, at, options);
    const currentState = entry.state;
    if (!currentState) {
      return undefined;
    }
    const nextState = reduceSessionDetailState(currentState, action);
    if (nextState === currentState) {
      entry.markAccessed(at);
      return currentState;
    }

    const approxBytes = estimateStateBytes(
      nextState,
      isEntryCreatingAction(action),
    );
    entry.applyState(nextState, at, options, approxBytes);
    const actionScrollSnapshot =
      action.type === "restoreRouteSnapshot"
        ? action.snapshot.scrollSnapshot
        : action.type === "loadPersistedTranscript"
          ? action.scrollSnapshot
          : undefined;
    if (actionScrollSnapshot) {
      entry.setScrollSnapshot(actionScrollSnapshot, at);
    }

    if (
      entry.approxBytes > getSessionDetailMaxBytes(options) &&
      entry.retainCount === 0
    ) {
      this.deleteRecordByKey(key);
      return undefined;
    }

    this.evictLeastRecentlyUsed(options);
    return nextState;
  }

  patchScrollSnapshot(
    input: SessionDetailEntryKeyInput,
    scrollSnapshot: SessionRouteScrollSnapshot,
    options: Pick<SessionDetailRetentionOptions, "nowMs"> & {
      notify?: boolean;
    } = {},
  ): void {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    const entry = this.entries.get(key);
    if (!entry || this.deleteIfExpired(entry, at)) {
      return;
    }
    entry.setScrollSnapshot(scrollSnapshot, at);
  }

  subscribe<T>(
    input: SessionDetailEntryKeyInput,
    selector: Selector<T>,
    listener: () => void,
    equality: Equality<T> = Object.is,
  ): () => void {
    const entry = this.getOrCreateEntry(input);
    const unsubscribe = entry.subscribe(selector, listener, equality);
    return () => {
      unsubscribe();
      this.deleteEntryIfIdle(entry);
    };
  }

  retain(
    input: SessionDetailEntryKeyInput,
    options: SessionDetailRetentionOptions = {},
  ): () => void {
    const at = getSessionDetailNow(options);
    const entry = this.ensureEntry(input, at, options);
    entry.incrementRetain(at, options);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release(input, {
        ...options,
        nowMs: getSessionDetailNow(options),
      });
    };
  }

  release(
    input: SessionDetailEntryKeyInput,
    options: SessionDetailRetentionOptions = {},
  ): void {
    const at = getSessionDetailNow(options);
    const entry = this.entries.get(getSessionDetailEntryKey(input));
    if (!entry) {
      return;
    }
    entry.release(at, options);
    this.deleteEntryIfIdle(entry);
  }

  evictExpired(
    options: Pick<SessionDetailRetentionOptions, "nowMs"> = {},
  ): number {
    const at = getSessionDetailNow(options);
    let evicted = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (this.deleteIfExpired(entry, at)) {
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Drop every unretained record — a warm-cache wipe. Retained entries
   * belong to mounted consumers: deleting their record would strip retain()
   * eviction protection and blank live transcript state, so they survive and
   * are disposed of by their owner's unmount path instead.
   */
  clear(): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.retainCount > 0) {
        continue;
      }
      entry.deleteRecord();
      this.deleteEntryIfIdle(entry);
    }
  }

  clearScrollSnapshots(): void {
    for (const entry of Array.from(this.entries.values())) {
      entry.clearScrollSnapshot();
    }
  }

  deleteEntry(input: SessionDetailEntryKeyInput): boolean {
    const key = getSessionDetailEntryKey(input);
    return this.deleteRecordByKey(key);
  }

  /**
   * Reset an entry's state to initial while preserving the entry itself -
   * unlike deleteEntry, this keeps retain() ownership intact, so a mounted
   * consumer restarting its load does not lose eviction protection.
   */
  resetEntryState(
    input: SessionDetailEntryKeyInput,
    options: Pick<SessionDetailRetentionOptions, "nowMs" | "ttlMs"> = {},
  ): void {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const state = entry.state;
    if (!state || (state.session === null && state.messages.length === 0)) {
      return;
    }
    entry.resetState(at, options);
  }

  getStats(): SessionDetailMemoryCacheStats {
    const recordEntries = this.recordEntries();
    const retainedEntries = recordEntries.filter(
      (entry) => entry.retainCount > 0,
    );
    const warmCacheEntries = recordEntries.filter(
      (entry) => entry.retainCount === 0,
    );
    const entries = recordEntries.map((entry) => entry.toStats());
    return {
      entryCount: entries.length,
      retainedEntryCount: retainedEntries.length,
      warmCacheEntryCount: warmCacheEntries.length,
      approxBytes: sumApproxBytes(recordEntries),
      dedupedApproxBytes: this.dedupedApproxBytes(recordEntries),
      retainedApproxBytes: sumApproxBytes(retainedEntries),
      retainedDedupedApproxBytes: this.dedupedApproxBytes(retainedEntries),
      warmCacheApproxBytes: sumApproxBytes(warmCacheEntries),
      warmCacheDedupedApproxBytes: this.dedupedApproxBytes(warmCacheEntries),
      entries,
    };
  }

  private ensureEntry(
    input: SessionDetailEntryKeyInput,
    at: number,
    options: SessionDetailRetentionOptions,
  ): SessionDetailEntry {
    const entry = this.getOrCreateEntry(input);
    entry.ensureRecord(at, options);
    return entry;
  }

  private readEntry(
    input: SessionDetailEntryKeyInput,
    options: Pick<SessionDetailRetentionOptions, "nowMs">,
  ): SessionDetailEntry | undefined {
    const at = getSessionDetailNow(options);
    const key = getSessionDetailEntryKey(input);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.deleteIfExpired(entry, at)) {
      return undefined;
    }
    entry.markAccessed(at);
    return entry;
  }

  private deleteIfExpired(entry: SessionDetailEntry, at: number): boolean {
    const deleted = entry.deleteIfExpired(at);
    if (deleted) {
      this.deleteEntryIfIdle(entry);
    }
    return deleted;
  }

  private evictLeastRecentlyUsed(
    options: SessionDetailRetentionOptions,
    protectedKeys: ReadonlySet<string> = new Set(),
  ): void {
    const maxEntryCount = getSessionDetailMaxEntries(options);
    const maxByteCount = getSessionDetailMaxBytes(options);
    const candidates = () =>
      this.recordEntries()
        .filter(
          (entry) => entry.retainCount === 0 && !protectedKeys.has(entry.key),
        )
        .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

    while (this.recordEntries().length > maxEntryCount) {
      const victim = candidates()[0];
      if (!victim) {
        break;
      }
      victim.deleteRecord();
      this.deleteEntryIfIdle(victim);
    }

    // The naive per-entry sum is an upper bound on deduped usage, so an
    // under-budget fast path avoids walking rows on ordinary dispatches.
    let naiveTotal = 0;
    for (const entry of this.recordEntries()) {
      naiveTotal += entry.approxBytes;
    }
    if (naiveTotal <= maxByteCount) {
      return;
    }

    while (this.dedupedApproxBytes() > maxByteCount) {
      const victim = candidates()[0];
      if (!victim) {
        break;
      }
      victim.deleteRecord();
      this.deleteEntryIfIdle(victim);
    }
  }

  /** Aggregate usage with rows shared across entries charged once. */
  private dedupedApproxBytes(
    entries: readonly SessionDetailEntry[] = this.recordEntries(),
  ): number {
    const seen = new Set<object>();
    let total = 0;
    for (const entry of entries) {
      total += entry.estimateBytes({
        measureUncached: false,
        seen,
      });
    }
    return total;
  }

  private getOrCreateEntry(
    input: SessionDetailEntryKeyInput,
  ): SessionDetailEntry {
    const key = getSessionDetailEntryKey(input);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new SessionDetailEntry(key, input);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private deleteRecordByKey(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    const deleted = entry.deleteRecord();
    this.deleteEntryIfIdle(entry);
    return deleted;
  }

  private deleteEntryIfIdle(entry: SessionDetailEntry): void {
    if (!entry.hasRecord && !entry.hasSubscriptions) {
      this.entries.delete(entry.key);
    }
  }

  private recordEntries(): SessionDetailEntry[] {
    return Array.from(this.entries.values()).filter((entry) => entry.hasRecord);
  }
}

function sumApproxBytes(entries: readonly SessionDetailEntry[]): number {
  return entries.reduce((total, entry) => total + entry.approxBytes, 0);
}
