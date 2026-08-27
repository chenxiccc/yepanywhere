import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../clientSummaryStore";
import {
  getSourceRuntimeRegistry,
  resetSourceRuntimeRegistryForTests,
} from "../../sourceRuntime";
import { FakeSourceTransport } from "../../transport";
import { ClientLogCollector } from "../ClientLogCollector";

// Mock fetchJSON to avoid real network calls
vi.mock("../../../api/client", () => ({
  fetchJSON: vi.fn(() => Promise.resolve({ received: 0 })),
}));

import { fetchJSON } from "../../../api/client";

const CLIENT_LOG_DB_NAME = "yep-anywhere-client-logs";
const CLIENT_LOG_STORE_NAME = "entries";

async function deleteClientLogDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CLIENT_LOG_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Client log database is open"));
  });
}

async function createEmptyClientLogDatabase(version: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(CLIENT_LOG_DB_NAME, version);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe("ClientLogCollector", () => {
  let collector: ClientLogCollector;
  let transport: FakeSourceTransport;
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;
  let testLog: typeof console.log;
  let testWarn: typeof console.warn;
  let testError: typeof console.error;

  beforeEach(async () => {
    await deleteClientLogDatabase();
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    testLog = console.log;
    testWarn = console.warn;
    testError = console.error;
    resetClientSummaryStoreForTests();
    resetSourceRuntimeRegistryForTests();
    const sourceKey = asClientSummarySourceKey("test:client-log");
    setCurrentClientSummarySourceKey(sourceKey);
    transport = new FakeSourceTransport({
      kind: "secure",
      initialSnapshot: {
        kind: "secure",
        state: "disconnected",
        channels: [],
      },
    });
    getSourceRuntimeRegistry().registerSourceTransport(sourceKey, {
      kind: "custom",
      createTransport: () => transport,
    });
    vi.clearAllMocks();
    collector = new ClientLogCollector();
  });

  afterEach(async () => {
    collector.stop();
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    resetSourceRuntimeRegistryForTests();
    resetClientSummaryStoreForTests();
    await deleteClientLogDatabase();
  });

  it("captures console messages and flushes with deviceId", async () => {
    await collector.start();

    console.log("[ConnectionManager] connected → reconnecting");
    console.warn("warn message");
    console.error("error message");

    await new Promise((r) => setTimeout(r, 10));

    vi.mocked(fetchJSON).mockResolvedValueOnce({ received: 4 });
    await collector.flush();

    expect(fetchJSON).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      vi.mocked(fetchJSON).mock.calls[0]?.[1]?.body as string,
    );
    // Should have ClientInfo entry + 3 console entries
    expect(body.entries.length).toBeGreaterThanOrEqual(4);
    expect(
      body.entries.some((e: { prefix: string }) => e.prefix === "[ClientInfo]"),
    ).toBe(true);
    expect(
      body.entries.some(
        (e: { prefix: string }) => e.prefix === "[ConnectionManager]",
      ),
    ).toBe(true);
  });

  it("samples transcript-store memory in telemetry entries", async () => {
    await collector.start();
    await new Promise((r) => setTimeout(r, 10));

    vi.mocked(fetchJSON).mockResolvedValueOnce({ received: 2 });
    await collector.flush();

    const body = JSON.parse(
      vi.mocked(fetchJSON).mock.calls[0]?.[1]?.body as string,
    );
    const telemetry = body.entries.find(
      (e: { prefix: string }) => e.prefix === "[ClientTelemetry]",
    );
    expect(telemetry).toBeDefined();
    const payload = JSON.parse(
      (telemetry.message as string).replace("[ClientTelemetry] ", ""),
    );
    expect(payload.dom).toMatchObject({
      nodes: expect.any(Number),
      messageRows: expect.any(Number),
    });
    expect(payload.transcriptMemory).toMatchObject({
      totalBytes: expect.any(Number),
      liveRetainedBytes: expect.any(Number),
      liveRetainedEntryCount: expect.any(Number),
      warmCacheBytes: expect.any(Number),
      warmCacheEntryCount: expect.any(Number),
    });
  });

  it("restores console on stop", async () => {
    await collector.start();
    expect(console.log).not.toBe(testLog);

    collector.stop();
    expect(console.log).toBe(testLog);
    expect(console.warn).toBe(testWarn);
    expect(console.error).toBe(testError);
  });

  it("flushes when the current transport becomes ready", async () => {
    await collector.start();

    console.log("test entry");
    await new Promise((r) => setTimeout(r, 10));

    vi.mocked(fetchJSON).mockResolvedValueOnce({ received: 1 });

    transport.setState("ready");

    await new Promise((r) => setTimeout(r, 10));
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });

  it("repairs an empty version-one database", async () => {
    await createEmptyClientLogDatabase(1);

    await collector.start();
    collector.record("info", "[RepairTest]", "repair marker");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await collector.flush();

    const body = JSON.parse(
      vi.mocked(fetchJSON).mock.calls[0]?.[1]?.body as string,
    );
    expect(
      body.entries.some(
        (entry: { message: string }) => entry.message === "repair marker",
      ),
    ).toBe(true);

    collector.stop();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(CLIENT_LOG_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains(CLIENT_LOG_STORE_NAME)).toBe(true);
    db.close();
  });

  it("falls back when a current database is missing its store", async () => {
    await createEmptyClientLogDatabase(2);

    await collector.start();
    collector.record("info", "[FallbackTest]", "fallback marker");
    await collector.flush();

    const body = JSON.parse(
      vi.mocked(fetchJSON).mock.calls[0]?.[1]?.body as string,
    );
    expect(
      body.entries.some(
        (entry: { message: string }) => entry.message === "fallback marker",
      ),
    ).toBe(true);
  });
});
