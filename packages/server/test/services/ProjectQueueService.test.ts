import {
  type StagedAttachmentRef,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectQueueService,
  ProjectQueueValidationError,
} from "../../src/services/ProjectQueueService.js";
import { AttachmentStagingService } from "../../src/uploads/index.js";
import { EventBus } from "../../src/watcher/EventBus.js";

async function completeDraftUpload(
  service: AttachmentStagingService,
  content: Buffer,
  batchId = "batch-a",
): Promise<{ batchId: string; ref: StagedAttachmentRef }> {
  const started = await service.startDraftUpload({
    batchId,
    originalName: "queued.txt",
    size: content.length,
    mimeType: "text/plain",
  });
  await service.writeChunk(started.uploadId, content);
  const ref = await service.completeUpload(started.uploadId);
  return { batchId: started.batchId, ref };
}

describe("ProjectQueueService", () => {
  let testDir: string;
  let projectId: UrlProjectId;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-queue-test-"));
    projectId = toUrlProjectId("/tmp/project-queue");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createService(
    eventBus?: EventBus,
    attachmentStagingService?: AttachmentStagingService,
  ): Promise<ProjectQueueService> {
    const service = new ProjectQueueService({
      dataDir: testDir,
      eventBus,
      attachmentStagingService,
    });
    await service.initialize();
    return service;
  }

  it("persists queued items across service re-instantiation", async () => {
    const service = await createService();
    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "follow up after the project is idle  " },
        createdFrom: { client: "toolbar", sessionId: "session-1" },
      },
    });

    const reloaded = await createService();
    const queue = reloaded.listProject(projectId);

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      id: created.id,
      projectId,
      target: { type: "existing-session", sessionId: "session-1" },
      messagePreview: "follow up after the project is idle",
      message: { text: "follow up after the project is idle  " },
      status: "queued",
      attachmentCount: 0,
      createdFrom: { client: "toolbar", sessionId: "session-1" },
    });
    expect(queue.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
  });

  it("preserves a project sandbox network-firewall opt-out", async () => {
    const service = await createService();
    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: {
          type: "new-session",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
        },
        message: { text: "start with direct host networking" },
      },
    });

    expect(created.target).toMatchObject({
      type: "new-session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
    const reloaded = await createService();
    expect(reloaded.listProject(projectId).items[0]?.target).toMatchObject({
      type: "new-session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
  });

  it("rejects a network firewall without project sandboxing", async () => {
    const service = await createService();

    await expect(
      service.createItem({
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: {
            type: "new-session",
            sandboxLevel: "none",
            sandboxNetworkFirewall: true,
          },
          message: { text: "invalid boundary" },
        },
      }),
    ).rejects.toThrow(
      "target.sandboxNetworkFirewall requires project-write sandboxing",
    );
  });

  it("persists manual dispatch pause across service re-instantiation", async () => {
    const service = await createService();
    await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for manual resume" },
      },
    });

    await service.pauseDispatch();
    const reloaded = await createService();

    expect(reloaded.getDispatchState()).toMatchObject({
      status: "paused",
      reason: "manual",
    });
  });

  it("rejects pausing an empty project queue", async () => {
    const service = await createService();

    await expect(service.pauseDispatch()).rejects.toBeInstanceOf(
      ProjectQueueValidationError,
    );
  });

  it("clears dispatch pause when the last item is deleted", async () => {
    const service = await createService();
    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "temporary queued work" },
      },
    });

    await service.pauseDispatch();
    await service.deleteItem(projectId, created.id);

    expect(service.getDispatchState()).toEqual({ status: "running" });
  });

  it("resumes dispatch after successful queued-item mutations", async () => {
    const service = await createService();
    const first = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first item" },
      },
    });
    const second = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second item" },
      },
    });

    await service.pauseDispatch("restart");
    await service.updateItem(projectId, first.id, {
      message: { text: "updated first item" },
    });
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.retryItem(projectId, first.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.moveItemToTop(projectId, second.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.deleteItem(projectId, second.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });
  });

  it("updates, retries, and deletes items with project-scoped events", async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "project-queue-changed") {
        events.push(
          `${event.reason}:${event.itemId ?? ""}:${event.items.length}`,
        );
      }
    });
    const service = await createService(eventBus);
    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "start later" },
        createdFrom: { client: "new-session" },
      },
    });

    const updated = await service.updateItem(projectId, created.id, {
      message: { text: "start later with more context" },
    });
    const retried = await service.retryItem(projectId, created.id);
    const deleted = await service.deleteItem(projectId, created.id);

    expect(updated?.messagePreview).toBe("start later with more context");
    expect(retried?.status).toBe("queued");
    expect(deleted).toBe(true);
    expect(service.listProject(projectId).items).toHaveLength(0);
    expect(events).toEqual([
      `created:${created.id}:1`,
      `updated:${created.id}:1`,
      `retry:${created.id}:1`,
      `deleted:${created.id}:0`,
    ]);
  });

  it("transfers staged draft attachments to queue ownership and deletes them on cancel", async () => {
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
    });
    const { batchId, ref } = await completeDraftUpload(
      stagingService,
      Buffer.from("queued attachment"),
    );
    const service = await createService(undefined, stagingService);

    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "start later with files",
          stagedAttachments: {
            batchId,
            refs: [ref],
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
        },
        createdFrom: { client: "new-session" },
      },
    });

    expect(created.attachmentCount).toBe(1);
    expect(created.message.stagedAttachments?.refs).toMatchObject([
      { id: ref.id, batchId },
    ]);
    expect(stagingService.getRecord(ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });
    await expect(stagingService.listDraftAttachments(batchId)).resolves.toEqual(
      [],
    );

    await expect(service.deleteItem(projectId, created.id)).resolves.toBe(true);
    expect(stagingService.getRecord(ref.id)).toBeNull();
  });

  it("rejects empty messages", async () => {
    const service = await createService();

    await expect(
      service.createItem({
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "   " },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);

    await expect(
      service.createItem({
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "   ", attachments: [] },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
  });

  it("filters malformed persisted items and resets dispatching items", async () => {
    await fs.writeFile(
      path.join(testDir, "project-queues.json"),
      JSON.stringify({
        version: 1,
        items: [
          { id: "bad", projectId: "not-a-url-project-id" },
          {
            id: "good",
            projectId,
            projectPath: "/tmp/project-queue",
            target: { type: "existing-session", sessionId: "session-1" },
            message: { text: "still queued after restart" },
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            status: "dispatching",
          },
        ],
      }),
    );

    const service = await createService();

    expect(service.listProject(projectId).items).toMatchObject([
      {
        id: "good",
        status: "queued",
        messagePreview: "still queued after restart",
      },
    ]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(testDir, "project-queues.json"), "utf-8"),
    );
    expect(persisted.items).toMatchObject([
      {
        id: "good",
        status: "queued",
      },
    ]);
    expect(persisted.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
  });

  it("serializes concurrent creates without dropping writes", async () => {
    const service = await createService();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.createItem({
          projectId,
          projectPath: "/tmp/project-queue",
          request: {
            target: { type: "existing-session", sessionId: `session-${index}` },
            message: { text: `message ${index}` },
          },
        }),
      ),
    );

    expect(
      service.listProject(projectId).items.map((item) => item.message.text),
    ).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
  });

  it("moves an item to the top of its project-local queue", async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "project-queue-changed") {
        events.push(`${event.reason}:${event.itemId ?? ""}`);
      }
    });
    const service = await createService(eventBus);
    const otherProjectId = toUrlProjectId("/tmp/project-queue-other");
    const first = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first project item" },
      },
    });
    const other = await service.createItem({
      projectId: otherProjectId,
      projectPath: "/tmp/project-queue-other",
      request: {
        target: { type: "existing-session", sessionId: "session-other" },
        message: { text: "other project item" },
      },
    });
    const second = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second project item" },
      },
    });
    const third = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-3" },
        message: { text: "third project item" },
      },
    });

    const moved = await service.moveItemToTop(projectId, second.id);

    expect(moved).toMatchObject({
      id: second.id,
      messagePreview: "second project item",
    });
    expect(service.listProject(projectId).items.map((item) => item.id)).toEqual(
      [second.id, first.id, third.id],
    );
    expect(service.listAll().map((item) => item.id)).toEqual([
      second.id,
      other.id,
      first.id,
      third.id,
    ]);
    expect(events).toContain(`reordered:${second.id}`);

    const reloaded = await createService();
    expect(
      reloaded.listProject(projectId).items.map((item) => item.id),
    ).toEqual([second.id, first.id, third.id]);
  });

  it("guards dispatching items from user-facing mutations", async () => {
    const service = await createService();
    const created = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "dispatch me" },
      },
    });

    const claimed = await service.claimNextDispatchableItem(projectId);

    expect(claimed?.id).toBe(created.id);
    expect(service.listProject(projectId).items[0]).toMatchObject({
      id: created.id,
      status: "dispatching",
    });
    await expect(
      service.updateItem(projectId, created.id, {
        message: { text: "changed" },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.deleteItem(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.retryItem(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.moveItemToTop(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);

    await service.releaseDispatchingItem(projectId, created.id);
    expect(service.listProject(projectId).items[0]?.status).toBe("queued");
  });

  it("returns transient startup failures to the head and pauses the third", async () => {
    const service = await createService();
    const first = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "ordinary first item" },
      },
    });
    const retrying = await service.createItem({
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "provider startup keeps failing" },
      },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await service.claimDispatchableItem(projectId, retrying.id);
      const updated = await service.recordRetryableStartupFailure(
        projectId,
        retrying.id,
        `startup failure ${attempt}`,
      );

      expect(
        service.listProject(projectId).items.map((item) => item.id),
      ).toEqual([retrying.id, first.id]);
      expect(updated).toMatchObject({
        status: attempt === 3 ? "failed" : "queued",
        lastError: `startup failure ${attempt}`,
      });
    }

    expect(service.hasDispatchableItem(projectId)).toBe(false);
    const persisted = JSON.parse(
      await fs.readFile(service.getFilePath(), "utf-8"),
    ) as { items: Array<{ id: string; startupFailureCount?: number }> };
    expect(
      persisted.items.find((item) => item.id === retrying.id)
        ?.startupFailureCount,
    ).toBe(3);

    await service.retryItem(projectId, retrying.id);
    expect(service.listProject(projectId).items[0]).toMatchObject({
      id: retrying.id,
      status: "queued",
      lastError: undefined,
    });
  });
});
