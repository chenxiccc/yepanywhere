import {
  type PermissionMode,
  type StagedAttachmentRef,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import type { UserMessage } from "../../src/sdk/types.js";
import {
  RetryableSessionLaunchError,
  type ModelSettings,
  type SessionLaunchOptions,
} from "../../src/supervisor/Supervisor.js";
import {
  ProjectQueueScheduler,
  type ProjectQueueDispatchResult,
  type ProjectQueueExternalTracker,
  type ProjectQueueProcessSnapshot,
  type ProjectQueueSupervisor,
} from "../../src/services/ProjectQueueScheduler.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { SessionQueuePersistenceService } from "../../src/services/SessionQueuePersistenceService.js";
import { AttachmentStagingService } from "../../src/uploads/index.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const PROJECT_PATH = "/tmp/project-queue-scheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await wait(5);
    }
  }
  if (lastError) throw lastError;
}

async function completeDraftUpload(
  service: AttachmentStagingService,
  content: Buffer,
): Promise<{ batchId: string; ref: StagedAttachmentRef }> {
  const started = await service.startDraftUpload({
    batchId: "batch-a",
    originalName: "queued.txt",
    size: content.length,
    mimeType: "text/plain",
  });
  await service.writeChunk(started.uploadId, content);
  const ref = await service.completeUpload(started.uploadId);
  return { batchId: started.batchId, ref };
}

function createProcess(
  projectId: UrlProjectId,
  overrides: Partial<ProjectQueueProcessSnapshot> = {},
): ProjectQueueProcessSnapshot {
  const process: ProjectQueueProcessSnapshot = {
    id: "process-1",
    sessionId: "session-1",
    projectId,
    projectPath: PROJECT_PATH,
    state: { type: "idle" },
    queueDepth: 0,
    provider: "claude",
    promptSuggestionMode: "native",
    recapAfterSeconds: 300,
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

class FakeSupervisor implements ProjectQueueSupervisor {
  processes: ProjectQueueProcessSnapshot[] = [];
  queueInfo: { projectId: UrlProjectId }[] = [];
  resumeCalls: {
    sessionId: string;
    projectPath: string;
    message: UserMessage;
  }[] = [];
  startCalls: { projectPath: string; message: UserMessage }[] = [];
  createCalls: { projectPath: string }[] = [];
  resumeError: Error | null = null;
  startError: Error | null = null;
  createError: Error | null = null;
  resumeBlocker: Promise<void> | null = null;
  queueNextStart = false;
  startModelSettings: Array<ModelSettings | undefined> = [];
  startLaunchOptions: SessionLaunchOptions | undefined;
  createLaunchOptions: SessionLaunchOptions | undefined;
  resumeLaunchOptions: SessionLaunchOptions | undefined;

  constructor(private projectId: UrlProjectId) {}

  getAllProcesses(): ProjectQueueProcessSnapshot[] {
    return this.processes;
  }

  getQueueInfo(): { projectId: UrlProjectId }[] {
    return this.queueInfo;
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    _permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.startCalls.push({ projectPath, message });
    this.startModelSettings.push(modelSettings);
    this.startLaunchOptions = launchOptions;
    if (this.startError) throw this.startError;
    if (this.queueNextStart) {
      return { queued: true, queueId: "worker-queue-1", position: 1 };
    }
    const process = createProcess(this.projectId, {
      id: `started-${this.startCalls.length}`,
      sessionId: `new-session-${this.startCalls.length}`,
    });
    this.processes.push(process);
    return process;
  }

  async createSession(
    projectPath: string,
    _permissionMode?: PermissionMode,
    _modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.createCalls.push({ projectPath });
    this.createLaunchOptions = launchOptions;
    if (this.createError) throw this.createError;
    const process = createProcess(this.projectId, {
      id: `created-${this.createCalls.length}`,
      sessionId: `created-session-${this.createCalls.length}`,
    });
    this.processes.push(process);
    return process;
  }

  async resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    _permissionMode?: PermissionMode,
    _modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.resumeCalls.push({ sessionId, projectPath, message });
    this.resumeLaunchOptions = launchOptions;
    await this.resumeBlocker;
    if (this.resumeError) throw this.resumeError;
    const process = createProcess(this.projectId, { sessionId });
    this.processes.push(process);
    return process;
  }
}

class FakeExternalTracker implements ProjectQueueExternalTracker {
  sessions = new Map<string, UrlProjectId>();

  getExternalSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async getExternalSessionInfoWithUrlId(
    sessionId: string,
  ): Promise<{ projectId: UrlProjectId; lastActivity: Date } | null> {
    const projectId = this.sessions.get(sessionId);
    return projectId ? { projectId, lastActivity: new Date() } : null;
  }
}

describe("ProjectQueueScheduler", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let eventBus: EventBus;
  let service: ProjectQueueService;
  let supervisor: FakeSupervisor;
  let scheduler: ProjectQueueScheduler;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-queue-scheduler-"),
    );
    projectId = toUrlProjectId(PROJECT_PATH);
    eventBus = new EventBus();
    service = new ProjectQueueService({ dataDir: testDir, eventBus });
    await service.initialize();
    supervisor = new FakeSupervisor(projectId);
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
    });
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("promotes an existing-session item when the project is idle", async () => {
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "run after idle  " },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));

    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      projectPath: PROJECT_PATH,
      message: {
        text: "run after idle  ",
        automaticSource: "project-queue",
      },
    });
    expect(service.listProject(projectId).items).toEqual([]);
  });

  it("holds automatic existing-session work behind a done boundary", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
      isSessionAutomationPaused: (sessionId) => sessionId === "session-1",
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for a real user turn" },
      },
    });

    await wait(25);
    await expect(scheduler.getProjectStatus(projectId)).resolves.toMatchObject({
      state: "blocked",
      blockers: ["session-1:automation-paused"],
      itemCount: 1,
    });
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("waits for the configured project quiet window before promoting", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 100,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for quiet" },
      },
    });

    await wait(30);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("blocks promotion while an admitted user session start is unresolved", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 25,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "queued-session" },
        message: { text: "wait for the user start" },
      },
    });
    const release = scheduler.reserveUserSessionStart(
      projectId,
      "user-session",
    );

    await wait(50);
    expect(supervisor.resumeCalls).toHaveLength(0);
    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: false,
      blockers: ["user-session:user-starting"],
    });

    release();
    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("waits for in-flight promotion work before disposing", async () => {
    let releaseResume!: () => void;
    supervisor.resumeBlocker = new Promise((resolve) => {
      releaseResume = resolve;
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "finish before teardown" },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));

    let disposed = false;
    const disposePromise = scheduler.dispose().then(() => {
      disposed = true;
    });
    await wait(25);
    expect(disposed).toBe(false);

    releaseResume();
    await disposePromise;

    expect(disposed).toBe(true);
    expect(service.listProject(projectId).items).toEqual([]);
  });

  it("restarts the project quiet window after session activity", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 100,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait after activity" },
      },
    });

    await wait(30);
    eventBus.emit({
      type: "session-updated",
      sessionId: "session-1",
      projectId,
      updatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });
    await wait(40);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("keeps a deferred new-session item until worker launch settles", async () => {
    supervisor.queueNextStart = true;
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "new-session", provider: "claude-gateway" },
        message: { text: "start when a worker is free" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(service.listProject(projectId).items).toEqual([
      expect.objectContaining({ status: "dispatching" }),
    ]);
    expect(supervisor.startLaunchOptions?.onFailed).toBeTypeOf("function");

    await supervisor.startLaunchOptions?.onFailed?.(
      'Claude Gateway no longer advertises model "old-model"',
    );

    await waitFor(() =>
      expect(service.listProject(projectId).items).toEqual([
        expect.objectContaining({
          status: "failed",
          lastError: 'Claude Gateway no longer advertises model "old-model"',
        }),
      ]),
    );
  });

  it("defaults queued project sandboxes to the network firewall", async () => {
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: {
          type: "new-session",
          provider: "claude",
          sandboxLevel: "project-write",
        },
        message: { text: "start with public-only networking" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startModelSettings[0]).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
    });
  });

  it("preserves a queued project sandbox network opt-out", async () => {
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: {
          type: "new-session",
          provider: "claude",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
        },
        message: { text: "start with direct host networking" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startModelSettings[0]).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
  });

  it("requeues a deferred new session after transient provider startup failure", async () => {
    supervisor.queueNextStart = true;
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "retry after Codex starts" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startLaunchOptions).toMatchObject({
      retryProviderStartupFailure: true,
      requireProviderSessionId: true,
    });
    await scheduler.dispose();

    await supervisor.startLaunchOptions?.onRetryableFailure?.(
      "Codex app-server socket timed out",
    );

    expect(service.listProject(projectId).items).toEqual([
      expect.objectContaining({
        status: "queued",
        messagePreview: "retry after Codex starts",
      }),
    ]);
  });

  it("requeues immediate startup failures and pauses the third attempt", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 10_000,
      blockedRetryMs: 10_000,
    });
    supervisor.startError = new RetryableSessionLaunchError(
      new Error("Codex app-server socket timed out"),
    );
    const item = await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "keep this prompt durable" },
      },
    });

    const firstResult = await scheduler.promoteNow(projectId, {
      itemId: item.id,
      force: true,
    });

    expect(firstResult).toMatchObject({
      promoted: false,
      reason: "blocked",
      itemId: item.id,
    });
    expect(supervisor.startLaunchOptions).toMatchObject({
      retryProviderStartupFailure: true,
      requireProviderSessionId: true,
    });
    expect(service.listProject(projectId).items).toEqual([
      expect.objectContaining({
        id: item.id,
        status: "queued",
        messagePreview: "keep this prompt durable",
      }),
    ]);

    await expect(
      scheduler.promoteNow(projectId, { itemId: item.id, force: true }),
    ).resolves.toMatchObject({ promoted: false, reason: "blocked" });
    await expect(
      scheduler.promoteNow(projectId, { itemId: item.id, force: true }),
    ).resolves.toMatchObject({ promoted: false, reason: "failed" });
    expect(service.listProject(projectId).items).toEqual([
      expect.objectContaining({
        id: item.id,
        status: "failed",
        lastError: expect.stringContaining("Codex app-server socket timed out"),
      }),
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        event: "project_queue_dispatch_retry_exhausted",
        projectId,
        error:
          "Provider session startup did not settle: Codex app-server socket timed out",
      },
      "Project queue item paused after repeated provider startup failures",
    );
  });

  it("materializes staged attachments before promoting a queued new session", async () => {
    await scheduler.dispose();
    const projectPath = path.join(testDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    const storagePolicy = new ProjectStoragePolicy({
      dataDir: path.join(testDir, "data"),
      getMode: () => "project",
    });
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
      storagePolicy,
    });
    service.setAttachmentStagingService(stagingService);
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      attachmentStagingService: stagingService,
      idleGraceMs: 1,
    });
    const { batchId, ref } = await completeDraftUpload(
      stagingService,
      Buffer.from("queued attachment"),
    );

    await service.createItem({
      projectId,
      projectPath,
      request: {
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "start later with file",
          stagedAttachments: {
            batchId,
            refs: [ref],
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
        },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));

    expect(supervisor.startCalls).toHaveLength(0);
    expect(supervisor.createCalls).toEqual([{ projectPath }]);
    expect(supervisor.createLaunchOptions).toMatchObject({
      retryProviderStartupFailure: true,
    });
    expect(supervisor.resumeLaunchOptions).toMatchObject({
      requireProviderSessionId: true,
    });
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "created-session-1",
      projectPath,
      message: {
        text: "start later with file",
        attachments: [
          {
            id: ref.id,
            originalName: "queued.txt",
            path: path.join(
              projectPath,
              ".yep",
              "attachments",
              "created-session-1",
              ref.name,
            ),
          },
        ],
      },
    });
    await expect(
      fs.readFile(
        path.join(
          projectPath,
          ".yep",
          "attachments",
          "created-session-1",
          ref.name,
        ),
        "utf-8",
      ),
    ).resolves.toBe("queued attachment");
    await waitFor(() => {
      expect(service.listProject(projectId).items).toEqual([]);
      expect(stagingService.getRecord(ref.id)).toBeNull();
    });
  });

  it("waits for an active owned process to become verified idle", async () => {
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked while active" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    process.state = { type: "idle" };
    eventBus.emit({
      type: "process-state-changed",
      sessionId: process.sessionId,
      projectId,
      activity: "idle",
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("blocks the relocated working project instead of the launch project", async () => {
    await scheduler.dispose();
    const destinationProjectId = toUrlProjectId("/tmp/relocated-project");
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    let effectiveProjectId = destinationProjectId;
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
      getEffectiveProcessProjectId: () => effectiveProjectId,
    });

    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: true,
      blockers: [],
    });
    await expect(
      scheduler.getProjectIdleStatus(destinationProjectId),
    ).resolves.toMatchObject({
      idle: false,
      blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
    });

    await service.createItem({
      projectId: destinationProjectId,
      projectPath: "/tmp/relocated-project",
      request: {
        target: { type: "existing-session", sessionId: "queued-session" },
        message: { text: "wait for relocated work" },
      },
    });
    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    effectiveProjectId = projectId;
    scheduler.sessionProjectChanged(destinationProjectId, projectId);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "queued-session",
      projectPath: "/tmp/relocated-project",
    });
  });

  it("reports project readiness blockers and keeps retrying blocked backlog", async () => {
    await scheduler.dispose();
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked then retry" },
      },
    });

    await wait(25);
    await expect(scheduler.getProjectStatus(projectId)).resolves.toMatchObject({
      state: "blocked",
      idle: false,
      blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
      itemCount: 1,
      nextItemId: expect.any(String),
    });
    expect(supervisor.resumeCalls).toHaveLength(0);

    process.state = { type: "idle" };

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 500);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      message: { text: "blocked then retry" },
    });
    await waitFor(async () => {
      await expect(
        scheduler.getProjectStatus(projectId),
      ).resolves.toMatchObject({
        state: "empty",
        itemCount: 0,
        inFlight: false,
      });
    }, 500);
  });

  it("promoteNow skips the quiet timer but preserves idle blockers", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 10_000,
    });

    const item = await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "start before quiet" },
      },
    });

    const promoted = await scheduler.promoteNow(projectId, { itemId: item.id });
    expect(promoted).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-1",
    });
    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      message: { text: "start before quiet" },
    });
  });

  it("force promote starts a specific item despite project blockers", async () => {
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    const item = await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "force despite blocker" },
      },
    });

    const blocked = await scheduler.promoteNow(projectId, { itemId: item.id });
    expect(blocked).toMatchObject({
      promoted: false,
      reason: "blocked",
      itemId: item.id,
      status: {
        state: "blocked",
        blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
      },
    });
    expect(supervisor.resumeCalls).toHaveLength(0);

    const forced = await scheduler.promoteNow(projectId, {
      itemId: item.id,
      force: true,
      deliveryIntent: "steer",
    });

    expect(forced).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-2",
    });
    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-2",
      message: {
        text: "force despite blocker",
        metadata: { deliveryIntent: "steer", steerNow: true },
      },
    });
  });

  it("resumes paused dispatch before force-promoting a queued item", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 10_000,
    });
    const item = await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "steer after restart" },
      },
    });
    await service.pauseDispatch("restart");

    const promoted = await scheduler.promoteNow(projectId, {
      itemId: item.id,
      force: true,
      deliveryIntent: "steer",
    });

    expect(promoted).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-1",
    });
    expect(service.getDispatchState()).toEqual({ status: "running" });
    expect(supervisor.resumeCalls).toMatchObject([
      {
        sessionId: "session-1",
        message: {
          text: "steer after restart",
          metadata: { deliveryIntent: "steer", steerNow: true },
        },
      },
    ]);
  });

  it("waits for recovered patient queues before promoting project work", async () => {
    await scheduler.dispose();
    const sessionQueuePersistenceService = new SessionQueuePersistenceService({
      dataDir: testDir,
      eventBus,
    });
    await sessionQueuePersistenceService.initialize();
    await sessionQueuePersistenceService.replaceAll([
      {
        id: "persisted-patient-1",
        sessionId: "session-1",
        projectId,
        projectPath: PROJECT_PATH,
        provider: "claude",
        kind: "patient",
        message: { text: "older recovered session work" },
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        queuedAt: "2026-06-30T00:00:00.000Z",
        status: "paused-after-restart",
      },
    ]);
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      sessionQueuePersistenceService,
      idleGraceMs: 1,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "project work waits" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);
    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: false,
      blockers: ["recovered-session-queue:1"],
    });

    await sessionQueuePersistenceService.deleteItem("persisted-patient-1");

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      projectPath: PROJECT_PATH,
      message: { text: "project work waits" },
    });
  });

  it("dispatches past a session whose user already queued /done", async () => {
    // The agent is still finishing some final action, but the user has
    // declared the session done, so it is no longer project backlog.
    const process = createProcess(projectId, {
      state: { type: "in-turn" },
      isRetainingProviderWork: () => true,
      getDeferredQueueSummary: () => [{ kind: "ya-command" }],
      hasPendingYaCommand: (command?: "done") => command === "done",
    });
    supervisor.processes = [process];

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "runs while /done settles" },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("still blocks on an in-turn session with no queued /done", async () => {
    const process = createProcess(projectId, {
      state: { type: "in-turn" },
      isRetainingProviderWork: () => true,
    });
    supervisor.processes = [process];

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "waits for the turn" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("waits for per-session deferred queues to drain", async () => {
    let deferredQueue: unknown[] = [{ id: "deferred-1" }];
    const process = createProcess(projectId, {
      getDeferredQueueSummary: () => deferredQueue,
    });
    supervisor.processes = [process];

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked by session queue" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    deferredQueue = [];
    eventBus.emit({
      type: "session-updated",
      sessionId: process.sessionId,
      projectId,
      updatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("waits for external ownership to clear", async () => {
    await scheduler.dispose();
    const externalTracker = new FakeExternalTracker();
    externalTracker.sessions.set("external-session", projectId);
    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      externalTracker,
      idleGraceMs: 1,
    });

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked by external" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    externalTracker.sessions.clear();
    eventBus.emit({
      type: "session-status-changed",
      sessionId: "external-session",
      projectId,
      ownership: { owner: "none" },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("does not promote while dispatch is paused and resumes on request", async () => {
    await scheduler.dispose();
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "paused project work" },
      },
    });
    await service.pauseDispatch();

    scheduler = new ProjectQueueScheduler({
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await service.resumeDispatch();

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("persists a failed dispatch and stops behind it", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    supervisor.resumeError = new Error("provider unavailable");

    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first" },
      },
    });
    await service.createItem({
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second" },
      },
    });

    await waitFor(() => {
      expect(service.listProject(projectId).items[0]).toMatchObject({
        status: "failed",
        lastError: "provider unavailable",
      });
    });
    await wait(25);

    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(service.listProject(projectId).items).toMatchObject([
      { status: "failed", messagePreview: "first" },
      { status: "queued", messagePreview: "second" },
    ]);
  });
});
