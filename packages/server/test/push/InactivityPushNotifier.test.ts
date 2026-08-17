import {
  toUrlProjectId,
  type ProjectQueueItemStatus,
  type ProjectQueueItemSummary,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InactivityPushNotifier } from "../../src/push/InactivityPushNotifier.js";
import type { PushService } from "../../src/push/PushService.js";
import type {
  ProjectWorkProcessSnapshot,
  ProjectWorkSupervisor,
} from "../../src/services/projectWorkIdle.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const PROJECT_PATH = "/tmp/inactivity-push-project";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProcess(
  projectId: UrlProjectId,
  overrides: Partial<ProjectWorkProcessSnapshot> = {},
): ProjectWorkProcessSnapshot {
  const process: ProjectWorkProcessSnapshot = {
    sessionId: "session-1",
    projectId,
    state: { type: "idle" },
    queueDepth: 0,
    isRetainingProviderWork: () => false,
    getPendingInputRequest: () => null,
    getDeferredQueueSummary: () => [],
    hasPendingYaCommand: () => false,
    getLivenessSnapshot: () => ({
      derivedStatus:
        process.state.type === "idle" ? "verified-idle" : "recently-active",
    }),
    ...overrides,
  };
  return process;
}

function createQueueItem(
  projectId: UrlProjectId,
  status: ProjectQueueItemStatus,
): ProjectQueueItemSummary {
  return {
    id: `queue-${status}`,
    projectId,
    target: { type: "existing-session", sessionId: "session-1" },
    messagePreview: "queued work",
    message: { text: "queued work" },
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    status,
    attachmentCount: 0,
  };
}

class FakeSupervisor implements ProjectWorkSupervisor {
  processes: ProjectWorkProcessSnapshot[] = [];
  queueInfo: { projectId: UrlProjectId }[] = [];

  getAllProcesses(): ProjectWorkProcessSnapshot[] {
    return this.processes;
  }

  getQueueInfo(): { projectId: UrlProjectId }[] {
    return this.queueInfo;
  }
}

describe("InactivityPushNotifier", () => {
  let projectId: UrlProjectId;
  let eventBus: EventBus;
  let supervisor: FakeSupervisor;
  let queueItems: ProjectQueueItemSummary[];
  let pushService: PushService;
  let notifier: InactivityPushNotifier;

  beforeEach(() => {
    projectId = toUrlProjectId(PROJECT_PATH);
    eventBus = new EventBus();
    supervisor = new FakeSupervisor();
    queueItems = [];
    pushService = {
      getSubscriptionCount: vi.fn(() => 1),
      isNotificationTypeEnabled: vi.fn(
        (type) => type === "projectInactive" || type === "yaInactive",
      ),
      sendToAll: vi.fn(async () => [
        { browserProfileId: "profile-1", success: true },
      ]),
    } as unknown as PushService;
  });

  afterEach(() => {
    notifier?.dispose();
    vi.restoreAllMocks();
  });

  function createNotifier(): InactivityPushNotifier {
    notifier = new InactivityPushNotifier({
      eventBus,
      pushService,
      supervisor,
      projectQueueService: { listAll: () => queueItems },
      debounceMs: 1,
    });
    return notifier;
  }

  it("does not notify when the first observed project state is inactive", async () => {
    supervisor.processes = [createProcess(projectId)];
    createNotifier();

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "idle",
      timestamp: "2026-06-28T00:00:00.000Z",
    });

    await wait(20);

    expect(pushService.sendToAll).not.toHaveBeenCalled();
  });

  it("sends project inactive after an active project becomes inactive", async () => {
    vi.mocked(pushService.isNotificationTypeEnabled).mockImplementation(
      (type) => type === "projectInactive",
    );
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    createNotifier();

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "in-turn",
      timestamp: "2026-06-28T00:00:00.000Z",
    });
    await wait(20);

    process.state = { type: "idle" };
    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "idle",
      timestamp: "2026-06-28T00:00:01.000Z",
    });

    await vi.waitFor(() => {
      expect(pushService.sendToAll).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(pushService.sendToAll).mock.calls[0]?.[0]).toMatchObject({
      type: "project-inactive",
      projectId,
      projectName: "inactivity-push-project",
    });
  });

  it("treats failed project queue items as inactive", async () => {
    vi.mocked(pushService.isNotificationTypeEnabled).mockImplementation(
      (type) => type === "projectInactive",
    );
    queueItems = [createQueueItem(projectId, "queued")];
    createNotifier();

    eventBus.emit({
      type: "project-queue-changed",
      projectId,
      items: queueItems,
      reason: "created",
      itemId: "queue-queued",
      timestamp: "2026-06-28T00:00:00.000Z",
    });
    await wait(20);
    expect(pushService.sendToAll).not.toHaveBeenCalled();

    queueItems = [createQueueItem(projectId, "failed")];
    eventBus.emit({
      type: "project-queue-changed",
      projectId,
      items: queueItems,
      reason: "failed",
      itemId: "queue-failed",
      timestamp: "2026-06-28T00:00:01.000Z",
    });

    await vi.waitFor(() => {
      expect(pushService.sendToAll).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(pushService.sendToAll).mock.calls[0]?.[0]).toMatchObject({
      type: "project-inactive",
      failedProjectQueueCount: 1,
    });
  });

  it("coalesces the final project inactive edge into YA inactive", async () => {
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    createNotifier();

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "in-turn",
      timestamp: "2026-06-28T00:00:00.000Z",
    });
    await wait(20);

    process.state = { type: "idle" };
    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "idle",
      timestamp: "2026-06-28T00:00:01.000Z",
    });

    await vi.waitFor(() => {
      expect(pushService.sendToAll).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(pushService.sendToAll).mock.calls[0]?.[0]).toMatchObject({
      type: "ya-inactive",
      projectCount: 1,
    });
  });

  it("sends inactivity pushes to the complete subscribed audience", async () => {
    vi.mocked(pushService.isNotificationTypeEnabled).mockImplementation(
      (type) => type === "projectInactive",
    );
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    createNotifier();

    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "in-turn",
      timestamp: "2026-06-28T00:00:00.000Z",
    });
    await wait(20);

    process.state = { type: "idle" };
    eventBus.emit({
      type: "process-state-changed",
      sessionId: "session-1",
      projectId,
      activity: "idle",
      timestamp: "2026-06-28T00:00:01.000Z",
    });

    await vi.waitFor(() => {
      expect(pushService.sendToAll).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(pushService.sendToAll).mock.calls[0]).toHaveLength(1);
  });
});
