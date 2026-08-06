import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
  SessionQueuePersistenceValidationError,
} from "../../src/services/SessionQueuePersistenceService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const FILE_NAME = "session-queued-messages.json";

function makeItem(
  overrides: Partial<PersistedSessionQueuedMessage> = {},
): PersistedSessionQueuedMessage {
  const now = "2026-06-30T09:00:00.000Z";
  return {
    id: "queued-1",
    sessionId: "ya-session-1",
    projectId: toUrlProjectId("/tmp/session-queue-project"),
    projectPath: "/tmp/session-queue-project",
    provider: "claude",
    kind: "deferred",
    message: {
      text: "continue after this turn",
      tempId: "temp-1",
      metadata: { deliveryIntent: "deferred" },
    },
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    status: "queued",
    ...overrides,
  };
}

describe("SessionQueuePersistenceService", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-queue-test-"));
    filePath = path.join(testDir, FILE_NAME);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createService(): Promise<SessionQueuePersistenceService> {
    const service = new SessionQueuePersistenceService({ dataDir: testDir });
    await service.initialize();
    return service;
  }

  it("persists valid entries and reloads them paused after restart", async () => {
    const service = await createService();

    await service.replaceAll([
      makeItem({
        id: "direct-1",
        kind: "direct",
        message: { text: "next direct message", tempId: "temp-direct" },
        source: { tempId: "temp-direct", requestId: "request-1" },
      }),
      makeItem({
        id: "patient-1",
        sessionId: "ya-session-2",
        kind: "patient",
        message: {
          text: "when done, follow up",
          tempId: "temp-patient",
          metadata: { deliveryIntent: "patient", patienceSeconds: 5 },
        },
      }),
    ]);

    expect(service.list().map((item) => item.status)).toEqual([
      "queued",
      "queued",
    ]);

    const reloaded = await createService();
    const items = reloaded.list();

    expect(items.map((item) => item.id)).toEqual(["direct-1", "patient-1"]);
    expect(items.map((item) => item.status)).toEqual([
      "paused-after-restart",
      "paused-after-restart",
    ]);
    expect(items[0]).toMatchObject({
      sessionId: "ya-session-1",
      kind: "direct",
      message: { text: "next direct message", tempId: "temp-direct" },
      source: { tempId: "temp-direct", requestId: "request-1" },
    });
    expect(reloaded.listSession("ya-session-2")).toHaveLength(1);
  });

  it("filters malformed disk entries and normalizes queued or claimed statuses", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 0,
        items: [
          { id: "bad-project", projectId: "not-a-url-project-id" },
          makeItem({ id: "queued", status: "queued" }),
          makeItem({ id: "claimed", status: "claimed" }),
          makeItem({
            id: "paused",
            status: "paused-after-restart",
          }),
        ],
      }),
    );

    const service = await createService();
    const items = service.list();

    expect(items.map((item) => item.id)).toEqual([
      "queued",
      "claimed",
      "paused",
    ]);
    expect(items.map((item) => item.status)).toEqual([
      "paused-after-restart",
      "paused-after-restart",
      "paused-after-restart",
    ]);

    const saved = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      version: number;
      items: PersistedSessionQueuedMessage[];
    };
    expect(saved.version).toBe(1);
    expect(saved.items).toHaveLength(3);
    expect(
      saved.items.every((item) => item.status === "paused-after-restart"),
    ).toBe(true);
  });

  it("serializes concurrent upserts and preserves queue order", async () => {
    const service = await createService();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.upsertItem(
          makeItem({
            id: `queued-${index}`,
            message: { text: `message ${index}` },
            queuedAt: `2026-06-30T09:00:0${index}.000Z`,
          }),
        ),
      ),
    );

    const reloaded = await createService();

    expect(reloaded.list().map((item) => item.id)).toEqual([
      "queued-0",
      "queued-1",
      "queued-2",
      "queued-3",
      "queued-4",
    ]);
  });

  it("removes the backing file when the queue becomes empty", async () => {
    const service = await createService();
    await service.upsertItem(makeItem());

    await expect(fs.access(filePath)).resolves.toBeUndefined();

    expect(await service.deleteItem("queued-1")).toBe(true);
    expect(service.list()).toEqual([]);
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits change events after successful mutations", async () => {
    const eventBus = new EventBus();
    const listener = vi.fn();
    eventBus.subscribe((event) => {
      if (event.type === "session-queue-persistence-changed") {
        listener(event.type);
      }
    });
    const service = new SessionQueuePersistenceService({
      dataDir: testDir,
      eventBus,
    });
    await service.initialize();

    await service.upsertItem(makeItem());
    await service.deleteItem("queued-1");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid caller mutations without changing current state", async () => {
    const service = await createService();
    await service.upsertItem(makeItem());

    await expect(
      service.replaceAll([
        {
          ...makeItem({ id: "bad" }),
          provider: "not-a-provider",
        } as unknown as PersistedSessionQueuedMessage,
      ]),
    ).rejects.toBeInstanceOf(SessionQueuePersistenceValidationError);

    expect(service.list().map((item) => item.id)).toEqual(["queued-1"]);
  });
});
