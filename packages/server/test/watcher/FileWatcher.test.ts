import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";

interface FileWatcherTestAccess {
  rescanInProgress: boolean;
  rescanAndEmit(reason: "fallback" | "periodic"): void;
  emitEvent(filePath: string, eventType: string): void;
  handleFileEvent(eventType: string, filename: string): void;
}

function forceRescan(
  watcher: FileWatcher,
  reason: "fallback" | "periodic" = "fallback",
): void {
  (watcher as unknown as FileWatcherTestAccess).rescanAndEmit(reason);
}

describe("FileWatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("attaches before building its initial tree baseline", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const dateDir = join(watchDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });
    const filePath = join(dateDir, "rollout-existing.jsonl");
    await writeFile(filePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    try {
      watcher.start();
      expect(watcher.getInitialBaselineState()).toBe("scheduled");
      const metrics = await watcher.waitForInitialBaseline();

      expect(metrics).toMatchObject({
        provider: "codex",
        watchDir,
        filesScanned: 1,
        filesIndexed: 1,
        directoryReadErrors: 0,
        statFailures: 0,
      });
      expect(metrics?.directoriesVisited).toBeGreaterThanOrEqual(4);
      expect(watcher.getInitialBaselineState()).toBe("complete");
      expect(events).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(filePath, '{"changed":true}\n');
      (watcher as unknown as FileWatcherTestAccess).emitEvent(
        filePath,
        "change",
      );
      expect(events.at(-1)).toMatchObject({
        path: filePath,
        changeType: "modify",
      });
    } finally {
      watcher.stop();
    }
  });

  it("preserves an event observed while the baseline is pending", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });
    const filePath = join(watchDir, "session.jsonl");
    await writeFile(filePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "claude",
      eventBus,
      debounceMs: 0,
      rescanSlowLogThresholdMs: 60_000,
    });

    try {
      watcher.start();
      (watcher as unknown as FileWatcherTestAccess).handleFileEvent(
        "change",
        "session.jsonl",
      );
      const metrics = await watcher.waitForInitialBaseline();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(metrics?.touchedPathsPreserved).toBe(1);
      expect(events).toEqual([
        expect.objectContaining({
          path: filePath,
          changeType: "modify",
        }),
      ]);
    } finally {
      watcher.stop();
    }
  });

  it("records fallback rescan metrics and emitted change counts", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const dateDir = join(watchDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const keepPath = join(dateDir, "rollout-keep.jsonl");
    const deletePath = join(dateDir, "rollout-delete.jsonl");
    const createPath = join(dateDir, "rollout-create.jsonl");
    await writeFile(keepPath, "{}\n");
    await writeFile(deletePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    forceRescan(watcher);
    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "create",
    ]);

    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(keepPath, '{"changed":true}\n');
    await writeFile(createPath, "{}\n");
    await rm(deletePath);

    forceRescan(watcher);

    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "delete",
      "modify",
    ]);
    expect(events.every((event) => event.fileType === "session")).toBe(true);

    const metrics = watcher.getLastRescanMetrics();
    expect(metrics).toMatchObject({
      provider: "codex",
      watchDir,
      reason: "fallback",
      knownFilesBefore: 2,
      currentFiles: 2,
      knownFilesAfter: 2,
      createEvents: 1,
      modifyEvents: 1,
      deleteEvents: 1,
      emittedEvents: 3,
      sessionEvents: 3,
      agentSessionEvents: 0,
      otherEvents: 0,
      directoryReadErrors: 0,
      statFailures: 0,
    });
    expect(metrics?.directoriesVisited).toBeGreaterThanOrEqual(4);
    expect(metrics?.filesScanned).toBe(2);
    expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies current Claude child transcripts and metadata together", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const subagentsDir = join(
      watchDir,
      "project-hash",
      "parent-session",
      "subagents",
    );
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, "agent-child.jsonl"), "{}\n");
    await writeFile(join(subagentsDir, "agent-child.meta.json"), "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "claude",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    forceRescan(watcher);

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.fileType === "agent-session")).toBe(
      true,
    );
  });

  it("records overlap skips on the next completed rescan", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus: new EventBus(),
      periodicRescanMs: 100,
      periodicRescanMaxBackoffMs: 1000,
      rescanSlowLogThresholdMs: 60_000,
    });
    const internals = watcher as unknown as FileWatcherTestAccess;

    internals.rescanInProgress = true;
    forceRescan(watcher, "periodic");
    internals.rescanInProgress = false;

    forceRescan(watcher, "periodic");

    expect(watcher.getLastRescanMetrics()).toMatchObject({
      reason: "periodic",
      periodicRescanCurrentMs: 100,
      periodicRescanNextMs: 200,
      periodicRescanBackoffReason: "overlap",
      overlapSkipsSinceLast: 1,
      overlapSkipsTotal: 1,
    });
    expect(watcher.getPeriodicRescanDelayMs()).toBe(200);
  });

  it("backs off and recovers periodic rescan delay from duration", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus: new EventBus(),
      periodicRescanMs: 100,
      periodicRescanMaxBackoffMs: 1000,
      rescanSlowLogThresholdMs: 60_000,
    });
    const dateNow = vi.spyOn(Date, "now");

    try {
      dateNow.mockReturnValue(1060);
      dateNow.mockReturnValueOnce(1000).mockReturnValueOnce(1060);
      forceRescan(watcher, "periodic");

      expect(watcher.getLastRescanMetrics()).toMatchObject({
        durationMs: 60,
        periodicRescanCurrentMs: 100,
        periodicRescanNextMs: 200,
        periodicRescanBackoffReason: "slow",
      });
      expect(watcher.getPeriodicRescanDelayMs()).toBe(200);

      dateNow.mockReset();
      dateNow.mockReturnValue(2005);
      dateNow.mockReturnValueOnce(2000).mockReturnValueOnce(2005);
      forceRescan(watcher, "periodic");

      expect(watcher.getLastRescanMetrics()).toMatchObject({
        durationMs: 5,
        periodicRescanCurrentMs: 200,
        periodicRescanNextMs: 100,
        periodicRescanBackoffReason: "recovered",
      });
      expect(watcher.getPeriodicRescanDelayMs()).toBe(100);
    } finally {
      dateNow.mockRestore();
    }
  });
});
