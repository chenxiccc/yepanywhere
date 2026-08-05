export interface SourceVersionedAcceptedValue<Value> {
  sourceVersion: string;
  value: Value;
}

export type SourceVersionedWorkResult<Value> =
  | {
      status: "computed" | "hit" | "joined";
      sourceVersion: string;
      value: Value;
      retained: boolean;
    }
  | {
      status: "stale";
      sourceVersion: string;
      previous?: Readonly<SourceVersionedAcceptedValue<Value>>;
    };

export interface SourceVersionedSingleFlightStats {
  cacheHits: number;
  acceptedPeeks: number;
  joinedCalls: number;
  workStarts: number;
  staleCompletions: number;
  failures: number;
  evictions: number;
  trackedKeys: number;
  retainedEntries: number;
  retainedBytes: number;
  inFlight: number;
}

export interface SourceVersionedSingleFlightOptions<Value> {
  maxRetainedBytes: number;
  estimateBytes(value: Value): number;
}

export interface SourceVersionedWorkOptions<Key, Value> {
  key: Key;
  /** Exact source identity observed immediately before this admission. */
  sourceVersion: string;
  compute(
    previous: Readonly<SourceVersionedAcceptedValue<Value>> | undefined,
  ): Promise<Value>;
  isCurrent(sourceVersion: string): boolean | Promise<boolean>;
}

interface RetainedValue<Value> extends SourceVersionedAcceptedValue<Value> {
  bytes: number;
  lastAccess: number;
}

interface InFlight<Value> {
  sourceVersion: string;
  invalidationGeneration: number;
  promise: Promise<SourceVersionedWorkResult<Value>>;
}

interface WorkEntry<Value> {
  invalidationGeneration: number;
  retained?: RetainedValue<Value>;
  inFlights: Set<InFlight<Value>>;
}

/**
 * Retains one accepted projection per logical key and coalesces work only when
 * callers observed the same source version. A changed source starts a distinct
 * generation, while a late completion is discarded instead of publishing over
 * newer evidence. Callers must freshly observe `sourceVersion`; `isCurrent`
 * closes the race between that observation and asynchronous completion.
 */
export class SourceVersionedSingleFlight<Key, Value> {
  private readonly entries = new Map<Key, WorkEntry<Value>>();
  private readonly maxRetainedBytes: number;
  private readonly estimateBytes: (value: Value) => number;
  private accessSequence = 0;
  private retainedBytes = 0;
  private cacheHits = 0;
  private acceptedPeeks = 0;
  private joinedCalls = 0;
  private workStarts = 0;
  private staleCompletions = 0;
  private failures = 0;
  private evictions = 0;

  constructor(options: SourceVersionedSingleFlightOptions<Value>) {
    if (
      !Number.isFinite(options.maxRetainedBytes) ||
      options.maxRetainedBytes < 0
    ) {
      throw new RangeError(
        "maxRetainedBytes must be a finite non-negative number",
      );
    }
    this.maxRetainedBytes = options.maxRetainedBytes;
    this.estimateBytes = options.estimateBytes;
  }

  run(
    options: SourceVersionedWorkOptions<Key, Value>,
  ): Promise<SourceVersionedWorkResult<Value>> {
    const entry = this.getOrCreateEntry(options.key);
    const invalidationGeneration = entry.invalidationGeneration;

    if (entry.retained?.sourceVersion === options.sourceVersion) {
      this.cacheHits += 1;
      entry.retained.lastAccess = ++this.accessSequence;
      return Promise.resolve({
        status: "hit",
        sourceVersion: options.sourceVersion,
        value: entry.retained.value,
        retained: true,
      });
    }

    let existing: InFlight<Value> | undefined;
    for (const candidate of entry.inFlights) {
      if (
        candidate.sourceVersion === options.sourceVersion &&
        candidate.invalidationGeneration === invalidationGeneration
      ) {
        existing = candidate;
        break;
      }
    }
    if (existing) {
      this.joinedCalls += 1;
      return existing.promise.then((result) =>
        result.status === "computed" ? { ...result, status: "joined" } : result,
      );
    }

    const previous = entry.retained
      ? {
          sourceVersion: entry.retained.sourceVersion,
          value: entry.retained.value,
        }
      : undefined;
    this.workStarts += 1;

    let inFlight!: InFlight<Value>;
    const promise = Promise.resolve()
      .then(() => options.compute(previous))
      .then(async (value): Promise<SourceVersionedWorkResult<Value>> => {
        if (
          entry.invalidationGeneration !== invalidationGeneration ||
          !(await options.isCurrent(options.sourceVersion)) ||
          entry.invalidationGeneration !== invalidationGeneration
        ) {
          this.staleCompletions += 1;
          return {
            status: "stale",
            sourceVersion: options.sourceVersion,
            ...(entry.retained
              ? {
                  previous: {
                    sourceVersion: entry.retained.sourceVersion,
                    value: entry.retained.value,
                  },
                }
              : {}),
          };
        }

        const bytes = this.measureValue(value);
        if (entry.retained) this.retainedBytes -= entry.retained.bytes;
        const retained: RetainedValue<Value> = {
          sourceVersion: options.sourceVersion,
          value,
          bytes,
          lastAccess: ++this.accessSequence,
        };
        entry.retained = retained;
        this.retainedBytes += bytes;
        this.trimToBudget();

        return {
          status: "computed",
          sourceVersion: options.sourceVersion,
          value,
          retained: entry.retained === retained,
        };
      })
      .catch((error: unknown) => {
        this.failures += 1;
        throw error;
      })
      .finally(() => {
        entry.inFlights.delete(inFlight);
        if (!entry.retained && entry.inFlights.size === 0) {
          this.entries.delete(options.key);
        }
      });
    inFlight = {
      sourceVersion: options.sourceVersion,
      invalidationGeneration,
      promise,
    };
    entry.inFlights.add(inFlight);
    return promise;
  }

  /**
   * Return the latest accepted value without asserting that its source is
   * still current. This is for non-blocking consumers that prefer boundedly
   * stale enrichment while a separate refresh runs in the background.
   */
  getAccepted(
    key: Key,
  ): Readonly<SourceVersionedAcceptedValue<Value>> | undefined {
    const retained = this.entries.get(key)?.retained;
    if (!retained) return undefined;
    this.acceptedPeeks += 1;
    retained.lastAccess = ++this.accessSequence;
    return { sourceVersion: retained.sourceVersion, value: retained.value };
  }

  invalidate(key: Key): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.invalidationGeneration += 1;
    this.releaseRetained(entry);
    if (entry.inFlights.size === 0) this.entries.delete(key);
  }

  clear(): void {
    for (const [key, entry] of this.entries) {
      entry.invalidationGeneration += 1;
      this.releaseRetained(entry);
      if (entry.inFlights.size === 0) this.entries.delete(key);
    }
  }

  getStats(): SourceVersionedSingleFlightStats {
    let retainedEntries = 0;
    let inFlight = 0;
    for (const entry of this.entries.values()) {
      if (entry.retained) retainedEntries += 1;
      inFlight += entry.inFlights.size;
    }
    return {
      cacheHits: this.cacheHits,
      acceptedPeeks: this.acceptedPeeks,
      joinedCalls: this.joinedCalls,
      workStarts: this.workStarts,
      staleCompletions: this.staleCompletions,
      failures: this.failures,
      evictions: this.evictions,
      trackedKeys: this.entries.size,
      retainedEntries,
      retainedBytes: this.retainedBytes,
      inFlight,
    };
  }

  private getOrCreateEntry(key: Key): WorkEntry<Value> {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: WorkEntry<Value> = {
      invalidationGeneration: 0,
      inFlights: new Set(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private measureValue(value: Value): number {
    const bytes = this.estimateBytes(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(
        "estimateBytes must return a finite non-negative number",
      );
    }
    return Math.ceil(bytes);
  }

  private trimToBudget(): void {
    while (this.retainedBytes > this.maxRetainedBytes) {
      let oldest: [Key, WorkEntry<Value>] | undefined;
      for (const [key, entry] of this.entries) {
        const retained = entry.retained;
        if (!retained) continue;
        const oldestRetained = oldest?.[1].retained;
        if (
          !oldestRetained ||
          retained.lastAccess < oldestRetained.lastAccess
        ) {
          oldest = [key, entry];
        }
      }
      if (!oldest) return;
      const [oldestKey, oldestEntry] = oldest;
      this.releaseRetained(oldestEntry);
      if (oldestEntry.inFlights.size === 0) {
        this.entries.delete(oldestKey);
      }
      this.evictions += 1;
    }
  }

  private releaseRetained(entry: WorkEntry<Value>): void {
    if (!entry.retained) return;
    this.retainedBytes -= entry.retained.bytes;
    entry.retained = undefined;
  }
}
