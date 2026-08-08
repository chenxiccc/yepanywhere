/**
 * BatchProcessor collects async tasks and processes them with limited concurrency.
 *
 * Designed to prevent memory spikes from processing many file change events simultaneously.
 * Tasks are deduplicated by key - if the same key is enqueued multiple times before
 * the batch flushes, only the last task runs.
 */

import { performance } from "node:perf_hooks";

type Task<T> = () => Promise<T>;

const RECENT_BATCH_DIAGNOSTICS_LIMIT = 16;

export interface BatchProcessorBatchDiagnostics {
  sequence: number;
  queuedAt: string;
  startedAt: string;
  completedAt: string;
  queueDelayMs: number;
  durationMs: number;
  taskCount: number;
  succeededTasks: number;
  failedTasks: number;
  totalTaskDurationMs: number;
  maxTaskDurationMs: number;
}

export interface BatchProcessorDiagnostics {
  batchMs: number;
  concurrency: number;
  pendingTasks: number;
  processing: boolean;
  inFlightTasks: number;
  flushScheduled: boolean;
  oldestPendingAgeMs: number | null;
  lastBatchSequence: number;
  counters: {
    enqueuedTasks: number;
    deduplicatedTasks: number;
    clearedTasks: number;
    batchesStarted: number;
    batchesCompleted: number;
    tasksStarted: number;
    tasksSucceeded: number;
    tasksFailed: number;
    totalTaskDurationMs: number;
    totalBatchDurationMs: number;
    maxInFlightTasks: number;
  };
  recentBatches: BatchProcessorBatchDiagnostics[];
}

export interface BatchProcessorOptions<T> {
  /** Max concurrent tasks (default: 5) */
  concurrency?: number;
  /** Batch window in ms - wait this long to collect events before processing (default: 300) */
  batchMs?: number;
  /** Called for each successful result */
  onResult?: (key: string, result: T) => void;
  /** Called on task error */
  onError?: (key: string, error: Error) => void;
}

export class BatchProcessor<T> {
  private pending: Map<string, Task<T>> = new Map();
  private processing = false;
  private flushTimeout: NodeJS.Timeout | null = null;
  private concurrency: number;
  private batchMs: number;
  private onResult?: (key: string, result: T) => void;
  private onError?: (key: string, error: Error) => void;
  private firstPendingAtMs: number | null = null;
  private firstPendingAtWallMs: number | null = null;
  private nextBatchSequence = 0;
  private inFlightTasks = 0;
  private enqueuedTasks = 0;
  private deduplicatedTasks = 0;
  private clearedTasks = 0;
  private batchesStarted = 0;
  private batchesCompleted = 0;
  private tasksStarted = 0;
  private tasksSucceeded = 0;
  private tasksFailed = 0;
  private totalTaskDurationMs = 0;
  private totalBatchDurationMs = 0;
  private maxInFlightTasks = 0;
  private recentBatches: BatchProcessorBatchDiagnostics[] = [];

  constructor(options: BatchProcessorOptions<T> = {}) {
    this.concurrency = options.concurrency ?? 5;
    this.batchMs = options.batchMs ?? 300;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  /**
   * Queue a task for processing.
   * If the same key is queued again before the batch flushes, the previous task is replaced.
   */
  enqueue(key: string, task: Task<T>): void {
    this.enqueuedTasks += 1;
    if (this.pending.has(key)) {
      this.deduplicatedTasks += 1;
    }
    if (this.pending.size === 0) {
      this.firstPendingAtMs = performance.now();
      this.firstPendingAtWallMs = Date.now();
    }
    this.pending.set(key, task);
    this.scheduleFlush();
  }

  /**
   * Get the number of pending tasks waiting to be processed.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Check if the processor is currently processing a batch.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /** Fixed-cost queue and recent-batch telemetry for maintenance snapshots. */
  getDiagnostics(): BatchProcessorDiagnostics {
    const nowMs = performance.now();
    return {
      batchMs: this.batchMs,
      concurrency: this.concurrency,
      pendingTasks: this.pending.size,
      processing: this.processing,
      inFlightTasks: this.inFlightTasks,
      flushScheduled: this.flushTimeout !== null,
      oldestPendingAgeMs:
        this.firstPendingAtMs === null
          ? null
          : roundMilliseconds(nowMs - this.firstPendingAtMs),
      lastBatchSequence: this.recentBatches.at(-1)?.sequence ?? 0,
      counters: {
        enqueuedTasks: this.enqueuedTasks,
        deduplicatedTasks: this.deduplicatedTasks,
        clearedTasks: this.clearedTasks,
        batchesStarted: this.batchesStarted,
        batchesCompleted: this.batchesCompleted,
        tasksStarted: this.tasksStarted,
        tasksSucceeded: this.tasksSucceeded,
        tasksFailed: this.tasksFailed,
        totalTaskDurationMs: roundMilliseconds(this.totalTaskDurationMs),
        totalBatchDurationMs: roundMilliseconds(this.totalBatchDurationMs),
        maxInFlightTasks: this.maxInFlightTasks,
      },
      recentBatches: this.recentBatches.map((batch) => ({ ...batch })),
    };
  }

  /**
   * Force immediate processing of pending tasks.
   * Useful for testing or shutdown scenarios.
   */
  async flush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    await this.processBatch();
  }

  /**
   * Cancel all pending tasks and clear the queue.
   */
  clear(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    this.clearedTasks += this.pending.size;
    this.pending.clear();
    this.firstPendingAtMs = null;
    this.firstPendingAtWallMs = null;
  }

  /**
   * Dispose of the processor, clearing all pending tasks.
   */
  dispose(): void {
    this.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimeout) return;

    this.flushTimeout = setTimeout(() => {
      this.flushTimeout = null;
      this.processBatch();
    }, this.batchMs);
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.pending.size === 0) return;
    this.processing = true;
    const sequence = ++this.nextBatchSequence;
    const startedAtMs = performance.now();
    const startedAtWallMs = Date.now();
    const queuedAtMs = this.firstPendingAtMs ?? startedAtMs;
    const queuedAtWallMs = this.firstPendingAtWallMs ?? startedAtWallMs;
    this.batchesStarted += 1;

    // Grab current batch and clear pending
    const batch = new Map(this.pending);
    this.pending.clear();
    this.firstPendingAtMs = null;
    this.firstPendingAtWallMs = null;

    const entries = Array.from(batch.entries());
    let succeededTasks = 0;
    let failedTasks = 0;
    let totalTaskDurationMs = 0;
    let maxTaskDurationMs = 0;

    try {
      // Process in chunks of `concurrency` size
      for (let i = 0; i < entries.length; i += this.concurrency) {
        const chunk = entries.slice(i, i + this.concurrency);
        await Promise.all(
          chunk.map(async ([key, task]) => {
            const taskStartedAtMs = performance.now();
            this.tasksStarted += 1;
            this.inFlightTasks += 1;
            this.maxInFlightTasks = Math.max(
              this.maxInFlightTasks,
              this.inFlightTasks,
            );
            try {
              const result = await task();
              this.onResult?.(key, result);
              this.tasksSucceeded += 1;
              succeededTasks += 1;
            } catch (err) {
              this.tasksFailed += 1;
              failedTasks += 1;
              this.onError?.(key, err as Error);
            } finally {
              const taskDurationMs = performance.now() - taskStartedAtMs;
              this.inFlightTasks -= 1;
              this.totalTaskDurationMs += taskDurationMs;
              totalTaskDurationMs += taskDurationMs;
              maxTaskDurationMs = Math.max(maxTaskDurationMs, taskDurationMs);
            }
          }),
        );
      }
    } finally {
      const completedAtMs = performance.now();
      const completedAtWallMs = Date.now();
      const durationMs = completedAtMs - startedAtMs;
      this.batchesCompleted += 1;
      this.totalBatchDurationMs += durationMs;
      this.recentBatches.push({
        sequence,
        queuedAt: new Date(queuedAtWallMs).toISOString(),
        startedAt: new Date(startedAtWallMs).toISOString(),
        completedAt: new Date(completedAtWallMs).toISOString(),
        queueDelayMs: roundMilliseconds(startedAtMs - queuedAtMs),
        durationMs: roundMilliseconds(durationMs),
        taskCount: entries.length,
        succeededTasks,
        failedTasks,
        totalTaskDurationMs: roundMilliseconds(totalTaskDurationMs),
        maxTaskDurationMs: roundMilliseconds(maxTaskDurationMs),
      });
      if (this.recentBatches.length > RECENT_BATCH_DIAGNOSTICS_LIMIT) {
        this.recentBatches.shift();
      }
      this.processing = false;

      // If more events arrived during processing, schedule another flush
      if (this.pending.size > 0) {
        this.scheduleFlush();
      }
    }
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
