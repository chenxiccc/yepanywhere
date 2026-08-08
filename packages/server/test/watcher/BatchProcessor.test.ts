import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchProcessor } from "../../src/watcher/BatchProcessor.js";

describe("BatchProcessor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should process tasks after batch window", async () => {
      const results: string[] = [];
      const processor = new BatchProcessor<string>({
        batchMs: 100,
        onResult: (_key, result) => results.push(result),
      });

      processor.enqueue("a", async () => "result-a");
      processor.enqueue("b", async () => "result-b");

      expect(results).toHaveLength(0);

      // Advance past batch window
      await vi.advanceTimersByTimeAsync(100);

      expect(results).toContain("result-a");
      expect(results).toContain("result-b");
    });

    it("should deduplicate by key - last task wins", async () => {
      const results: string[] = [];
      const processor = new BatchProcessor<string>({
        batchMs: 100,
        onResult: (_key, result) => results.push(result),
      });

      processor.enqueue("same-key", async () => "first");
      processor.enqueue("same-key", async () => "second");
      processor.enqueue("same-key", async () => "third");

      await vi.advanceTimersByTimeAsync(100);

      expect(results).toEqual(["third"]);
    });

    it("should respect concurrency limit", async () => {
      const concurrentCount = { current: 0, max: 0 };
      const processor = new BatchProcessor<void>({
        batchMs: 50,
        concurrency: 2,
      });

      const createTask = () => async () => {
        concurrentCount.current++;
        concurrentCount.max = Math.max(
          concurrentCount.max,
          concurrentCount.current,
        );
        await new Promise((r) => setTimeout(r, 100));
        concurrentCount.current--;
      };

      // Queue 5 tasks
      for (let i = 0; i < 5; i++) {
        processor.enqueue(`task-${i}`, createTask());
      }

      // Start processing
      await vi.advanceTimersByTimeAsync(50);

      // Let all tasks complete
      await vi.advanceTimersByTimeAsync(300);

      expect(concurrentCount.max).toBe(2);
    });
  });

  describe("error handling", () => {
    it("should call onError for failed tasks", async () => {
      const errors: Array<{ key: string; message: string }> = [];
      const results: string[] = [];

      const processor = new BatchProcessor<string>({
        batchMs: 50,
        onResult: (_key, result) => results.push(result),
        onError: (key, error) => errors.push({ key, message: error.message }),
      });

      processor.enqueue("good", async () => "success");
      processor.enqueue("bad", async () => {
        throw new Error("task failed");
      });

      await vi.advanceTimersByTimeAsync(50);

      expect(results).toEqual(["success"]);
      expect(errors).toEqual([{ key: "bad", message: "task failed" }]);
    });

    it("should continue processing after errors", async () => {
      const results: string[] = [];

      const processor = new BatchProcessor<string>({
        batchMs: 50,
        concurrency: 1, // Sequential to test order
        onResult: (_key, result) => results.push(result),
        onError: () => {}, // Ignore errors
      });

      processor.enqueue("1", async () => "first");
      processor.enqueue("2", async () => {
        throw new Error("fail");
      });
      processor.enqueue("3", async () => "third");

      await vi.advanceTimersByTimeAsync(50);

      expect(results).toContain("first");
      expect(results).toContain("third");
    });
  });

  describe("flush()", () => {
    it("should process immediately without waiting for timer", async () => {
      const results: string[] = [];
      const processor = new BatchProcessor<string>({
        batchMs: 1000, // Long delay
        onResult: (_key, result) => results.push(result),
      });

      processor.enqueue("a", async () => "result-a");

      expect(results).toHaveLength(0);

      await processor.flush();

      expect(results).toEqual(["result-a"]);
    });
  });

  describe("clear()", () => {
    it("should cancel pending tasks", async () => {
      const results: string[] = [];
      const processor = new BatchProcessor<string>({
        batchMs: 100,
        onResult: (_key, result) => results.push(result),
      });

      processor.enqueue("a", async () => "result-a");
      expect(processor.pendingCount).toBe(1);

      processor.clear();
      expect(processor.pendingCount).toBe(0);

      await vi.advanceTimersByTimeAsync(100);
      expect(results).toHaveLength(0);
    });
  });

  describe("events arriving during processing", () => {
    it("should queue new events and process them after current batch", async () => {
      const results: string[] = [];
      const processor = new BatchProcessor<string>({
        batchMs: 50,
        concurrency: 1,
        onResult: (_key, result) => results.push(result),
      });

      // First batch
      processor.enqueue("first", async () => {
        // Enqueue during processing
        processor.enqueue("second", async () => "from-second-batch");
        return "from-first-batch";
      });

      // Process first batch
      await vi.advanceTimersByTimeAsync(50);

      expect(results).toContain("from-first-batch");
      expect(processor.pendingCount).toBe(1);

      // Process second batch
      await vi.advanceTimersByTimeAsync(50);

      expect(results).toContain("from-second-batch");
    });
  });

  describe("pendingCount and isProcessing", () => {
    it("should track pending count correctly", () => {
      const processor = new BatchProcessor<string>({ batchMs: 100 });

      expect(processor.pendingCount).toBe(0);

      processor.enqueue("a", async () => "a");
      expect(processor.pendingCount).toBe(1);

      processor.enqueue("b", async () => "b");
      expect(processor.pendingCount).toBe(2);

      // Same key replaces, count stays same
      processor.enqueue("a", async () => "a2");
      expect(processor.pendingCount).toBe(2);
    });

    it("should report isProcessing during batch execution", async () => {
      const processor = new BatchProcessor<string>({
        batchMs: 50,
        concurrency: 1,
      });

      expect(processor.isProcessing).toBe(false);

      let wasProcessing = false;
      processor.enqueue("a", async () => {
        wasProcessing = processor.isProcessing;
        return "done";
      });

      await vi.advanceTimersByTimeAsync(50);

      expect(wasProcessing).toBe(true);
      expect(processor.isProcessing).toBe(false);
    });
  });

  describe("diagnostics", () => {
    it("reports queue deduplication and bounded batch timing events", async () => {
      const processor = new BatchProcessor<string>({
        batchMs: 100,
        concurrency: 2,
      });

      processor.enqueue("same", async () => "first");
      processor.enqueue("same", async () => "replacement");
      processor.enqueue("other", async () => "other");

      expect(processor.getDiagnostics()).toMatchObject({
        pendingTasks: 2,
        processing: false,
        flushScheduled: true,
        counters: {
          enqueuedTasks: 3,
          deduplicatedTasks: 1,
          batchesStarted: 0,
        },
      });

      await vi.advanceTimersByTimeAsync(100);

      const diagnostics = processor.getDiagnostics();
      expect(diagnostics).toMatchObject({
        pendingTasks: 0,
        processing: false,
        inFlightTasks: 0,
        flushScheduled: false,
        lastBatchSequence: 1,
        counters: {
          batchesStarted: 1,
          batchesCompleted: 1,
          tasksStarted: 2,
          tasksSucceeded: 2,
          tasksFailed: 0,
          maxInFlightTasks: 2,
        },
      });
      expect(diagnostics.recentBatches).toHaveLength(1);
      expect(diagnostics.recentBatches[0]).toMatchObject({
        sequence: 1,
        taskCount: 2,
        succeededTasks: 2,
        failedTasks: 0,
      });
      expect(diagnostics.recentBatches[0]?.queueDelayMs).toBeGreaterThanOrEqual(
        0,
      );
      expect(diagnostics.recentBatches[0]?.durationMs).toBeGreaterThanOrEqual(
        0,
      );
    });

    it("retains only the latest sixteen batch events", async () => {
      const processor = new BatchProcessor<string>({ batchMs: 100 });

      for (let sequence = 1; sequence <= 17; sequence += 1) {
        processor.enqueue(String(sequence), async () => String(sequence));
        await processor.flush();
      }

      const diagnostics = processor.getDiagnostics();
      expect(diagnostics.lastBatchSequence).toBe(17);
      expect(diagnostics.recentBatches).toHaveLength(16);
      expect(diagnostics.recentBatches[0]?.sequence).toBe(2);
      expect(diagnostics.recentBatches.at(-1)?.sequence).toBe(17);
    });
  });
});
