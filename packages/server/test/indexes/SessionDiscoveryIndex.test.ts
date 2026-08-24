import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionDiscoveryIndex,
  SessionDiscoveryIndexRegistry,
  type SessionDiscoveryShardState,
} from "../../src/indexes/SessionDiscoveryIndex.js";

describe("SessionDiscoveryIndex", () => {
  let testDir: string;
  let baseDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-discovery-index-${randomUUID()}`);
    baseDir = join(testDir, "indexes", "session-discovery");
    sourceRoot = join(testDir, "provider-history");
    await mkdir(sourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("persists and reloads provider-neutral shard records", async () => {
    const index = new SessionDiscoveryIndex({
      baseDir,
      provider: "codex",
      sourceRoot,
    });

    await index.upsertRecord("2026/06/25", {
      key: "rollout-1.jsonl",
      relativePath: "2026/06/25/rollout-1.jsonl",
      representation: "plain",
      metadata: {
        id: "session-1",
        cwd: "/tmp/project",
        timestamp: "2026-06-25T10:00:00.000Z",
      },
      metadataByteLength: 120,
      fileSize: 500,
      fileMtimeMs: 1234,
      sourceFingerprint: {
        dev: 1,
        ino: 2,
        birthtimeMs: 3,
      },
    });
    await index.flush();

    const shardPath = index.getShardPath("2026/06/25");
    const shardStats = await stat(shardPath);
    expect(shardStats.isFile()).toBe(true);

    const reloaded = new SessionDiscoveryIndex({
      baseDir,
      provider: "codex",
      sourceRoot,
    });
    const record = await reloaded.getRecord<{
      id: string;
      cwd: string;
      timestamp: string;
    }>("2026/06/25", "rollout-1.jsonl");

    expect(record?.metadata.id).toBe("session-1");
    expect(record?.metadata.cwd).toBe("/tmp/project");
    expect(record?.relativePath).toBe("2026/06/25/rollout-1.jsonl");
    expect(record?.sourceFingerprint).toEqual({
      dev: 1,
      ino: 2,
      birthtimeMs: 3,
    });
  });

  it("ignores malformed shard files", async () => {
    const index = new SessionDiscoveryIndex({
      baseDir,
      provider: "codex",
      sourceRoot,
    });
    const shardPath = index.getShardPath("2026/06/25");
    await mkdir(dirname(shardPath), { recursive: true });
    await writeFile(shardPath, "not json{{{");

    const record = await index.getRecord("2026/06/25", "missing.jsonl");

    expect(record).toBeNull();
    const content = await readFile(shardPath, "utf-8");
    expect(content).toBe("not json{{{");
  });

  it("shares one cold shard load across concurrent upserts", async () => {
    const index = new SessionDiscoveryIndex({
      baseDir,
      provider: "codex",
      sourceRoot,
    });
    const internals = index as unknown as {
      readShardFromDisk: (
        shardKey: string,
      ) => Promise<SessionDiscoveryShardState>;
    };
    const originalRead = internals.readShardFromDisk.bind(index);
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readSpy = vi
      .spyOn(internals, "readShardFromDisk")
      .mockImplementation(async (shardKey) => {
        const shard = await originalRead(shardKey);
        signalReadStarted?.();
        await readGate;
        return shard;
      });

    const firstUpsert = index.upsertRecord("2026/08/24", {
      key: "first.jsonl",
      relativePath: "2026/08/24/first.jsonl",
      metadata: { id: "first" },
      metadataByteLength: 10,
      fileSize: 100,
      fileMtimeMs: 1,
    });
    const secondUpsert = index.upsertRecord("2026/08/24", {
      key: "second.jsonl",
      relativePath: "2026/08/24/second.jsonl",
      metadata: { id: "second" },
      metadataByteLength: 10,
      fileSize: 100,
      fileMtimeMs: 2,
    });

    await readStarted;
    expect(readSpy).toHaveBeenCalledTimes(1);
    releaseRead?.();
    await Promise.all([firstUpsert, secondUpsert]);
    await index.flush();

    const reloaded = new SessionDiscoveryIndex({
      baseDir,
      provider: "codex",
      sourceRoot,
    });
    expect(
      await reloaded.getRecord("2026/08/24", "first.jsonl"),
    ).not.toBeNull();
    expect(
      await reloaded.getRecord("2026/08/24", "second.jsonl"),
    ).not.toBeNull();
  });

  it("returns one process owner for the same durable index", () => {
    const registry = new SessionDiscoveryIndexRegistry();
    const first = registry.getOrCreate({
      baseDir,
      provider: "codex",
      sourceRoot,
    });
    const second = registry.getOrCreate({
      baseDir: join(baseDir, "."),
      provider: "codex",
      sourceRoot: join(sourceRoot, "."),
    });

    expect(second).toBe(first);
  });
});
