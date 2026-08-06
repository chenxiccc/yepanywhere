import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type StoredWorkstream,
  type WorkstreamId,
  mainWorkstreamId,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkstreamCheckoutError } from "../../src/services/WorkstreamService.js";
import {
  WorkstreamOperationInProgressError,
  WorkstreamService,
  WorkstreamValidationError,
} from "../../src/services/WorkstreamService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const execFileAsync = promisify(execFile);
const FILE_NAME = "workstreams.json";
const NOW = "2026-07-04T10:00:00.000Z";
const PROJECT_PATH = "/tmp/workstreams-project";

async function runGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    env: {
      ...process.env,
      GCM_INTERACTIVE: "Never",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function initGitProject(projectPath: string): Promise<void> {
  await fs.mkdir(projectPath, { recursive: true });
  try {
    await runGit(["init", "-b", "main", projectPath]);
  } catch {
    await runGit(["init", projectPath]);
    await runGit(["-C", projectPath, "checkout", "-b", "main"]);
  }
}

function shortProjectHash(projectId: UrlProjectId): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 10);
}

describe("WorkstreamService", () => {
  let testDir: string;
  let filePath: string;
  let projectId: UrlProjectId;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "workstreams-test-"));
    filePath = path.join(testDir, FILE_NAME);
    projectId = toUrlProjectId(PROJECT_PATH);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function makeWorkstream(
    overrides: Partial<StoredWorkstream> = {},
  ): StoredWorkstream {
    return {
      id: "ws-tools" as WorkstreamId,
      projectId,
      label: "tools cleanup",
      kind: "checkout",
      path: "/tmp/workstreams-project-tools",
      branch: "main",
      baseBranch: "main",
      baseCommit: null,
      managedByYa: true,
      queuePaused: false,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  async function createService(
    eventBus?: EventBus,
  ): Promise<WorkstreamService> {
    const service = new WorkstreamService({
      dataDir: testDir,
      eventBus,
      now: () => new Date(NOW),
    });
    await service.initialize();
    return service;
  }

  it("synthesizes the implicit main workstream without writing a file", async () => {
    const service = await createService();

    const workstreams = service.listProject({
      projectId,
      projectPath: PROJECT_PATH,
      mainBranch: "trunk",
    });

    expect(workstreams).toEqual([
      {
        id: mainWorkstreamId(projectId),
        projectId,
        label: "main",
        kind: "main",
        path: PROJECT_PATH,
        branch: "trunk",
        baseBranch: "trunk",
        baseCommit: null,
        managedByYa: false,
        queuePaused: false,
        status: "active",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
    expect(service.listStored()).toEqual([]);
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists non-main workstreams and lists main first", async () => {
    const service = await createService();

    await service.upsertWorkstream(makeWorkstream());

    const reloaded = await createService();
    const workstreams = reloaded.listProject({
      projectId,
      projectPath: PROJECT_PATH,
    });

    expect(workstreams.map((workstream) => workstream.id)).toEqual([
      mainWorkstreamId(projectId),
      "ws-tools",
    ]);
    expect(workstreams[1]).toMatchObject({
      label: "tools cleanup",
      kind: "checkout",
      path: "/tmp/workstreams-project-tools",
      branch: "main",
      managedByYa: true,
    });

    const saved = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      version: number;
      workstreams: StoredWorkstream[];
    };
    expect(saved.version).toBe(1);
    expect(saved.workstreams).toHaveLength(1);
    expect(saved.workstreams[0]?.kind).toBe("checkout");
    expect(saved.workstreams[0]?.id).toBe("ws-tools");
  });

  it("filters malformed, duplicate, and implicit-main disk records", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 0,
        workstreams: [
          { id: "bad-project", projectId: "not-a-url-project-id" },
          makeWorkstream({ id: "ws-valid" as WorkstreamId }),
          makeWorkstream({
            id: "ws-valid" as WorkstreamId,
            label: "duplicate",
          }),
          makeWorkstream({ id: mainWorkstreamId(projectId) }),
        ],
      }),
    );

    const service = await createService();

    expect(service.listStored().map((workstream) => workstream.id)).toEqual([
      "ws-valid",
    ]);

    const saved = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      version: number;
      workstreams: StoredWorkstream[];
    };
    expect(saved.version).toBe(1);
    expect(saved.workstreams).toHaveLength(1);
    expect(saved.workstreams[0]?.id).toBe("ws-valid");
  });

  it("creates metadata-only workstreams with default durable state", async () => {
    const service = await createService();

    const created = await service.createWorkstream({
      projectId,
      label: "world CRUD",
      path: "/tmp/workstreams-project-world",
      branch: "main",
      managedByYa: true,
    });

    expect(created).toMatchObject({
      projectId,
      label: "world CRUD",
      kind: "checkout",
      path: "/tmp/workstreams-project-world",
      branch: "main",
      baseBranch: "main",
      baseCommit: null,
      managedByYa: true,
      queuePaused: false,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(created.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });

  it("previews checkout destinations under the data directory", async () => {
    const projectPath = path.join(testDir, "repo");
    await initGitProject(projectPath);
    const service = await createService();

    const preview = await service.previewCheckoutWorkstream({
      projectId,
      projectPath,
      projectName: "Example Repo",
      label: "Feature Lane",
    });

    expect(preview).toMatchObject({
      label: "Feature Lane",
      slug: "feature-lane",
    });
    expect(preview.checkoutRootPath).toBe(
      path.join(
        testDir,
        "checkouts",
        `example-repo-${shortProjectHash(projectId)}`,
        "feature-lane",
      ),
    );
    expect(preview.checkoutPath).toBe(preview.checkoutRootPath);
  });

  it("resolves stored checkout paths back to their workstream", async () => {
    const service = await createService();
    await service.upsertWorkstream(
      makeWorkstream({
        path: path.join(testDir, "checkouts", "repo", "feature"),
      }),
    );

    expect(
      service.resolvePath(
        path.join(testDir, "checkouts", "repo", "feature", "src"),
      ),
    ).toMatchObject({
      projectId,
      workstreamId: "ws-tools",
      workstream: {
        id: "ws-tools",
        projectId,
        path: path.join(testDir, "checkouts", "repo", "feature"),
      },
    });
    expect(
      service.resolvePath(path.join(testDir, "checkouts", "repo-other")),
    ).toBeNull();
  });

  it("creates a real checkout lane and persists metadata after setup", async () => {
    const projectPath = path.join(testDir, "repo");
    await initGitProject(projectPath);
    await fs.writeFile(
      path.join(projectPath, ".worktreeinclude"),
      ".env.local\ncache/config.json\n",
    );
    await fs.writeFile(path.join(projectPath, ".env.local"), "TOKEN=local\n");
    await fs.mkdir(path.join(projectPath, "cache"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "cache/config.json"),
      '{"ok":true}\n',
    );
    const service = await createService();

    const { workstream, destination } = await service.createCheckoutWorkstream({
      projectId,
      projectPath,
      projectName: "Example Repo",
      label: "Feature Lane",
    });

    await expect(
      fs.access(path.join(destination.checkoutRootPath, ".git")),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(
        path.join(destination.checkoutRootPath, ".env.local"),
        "utf-8",
      ),
    ).resolves.toBe("TOKEN=local\n");
    await expect(
      fs.readFile(
        path.join(destination.checkoutRootPath, "cache/config.json"),
        "utf-8",
      ),
    ).resolves.toBe('{"ok":true}\n');
    expect(workstream).toMatchObject({
      projectId,
      label: "Feature Lane",
      kind: "checkout",
      path: destination.checkoutPath,
      branch: "main",
      baseBranch: "main",
      managedByYa: true,
      queuePaused: false,
      status: "active",
    });
    expect(service.listStoredProject(projectId)).toHaveLength(1);
  });

  it("rejects checkout creation for non-git projects", async () => {
    const projectPath = path.join(testDir, "not-git");
    await fs.mkdir(projectPath, { recursive: true });
    const service = await createService();

    await expect(
      service.createCheckoutWorkstream({
        projectId,
        projectPath,
        label: "Feature Lane",
      }),
    ).rejects.toMatchObject({
      code: "not_git_repository",
      status: 400,
    } satisfies Partial<WorkstreamCheckoutError>);
  });

  it("allows only one checkout operation per project at a time", async () => {
    const projectPath = path.join(testDir, "repo");
    await initGitProject(projectPath);
    const service = await createService();

    const results = await Promise.allSettled([
      service.createCheckoutWorkstream({
        projectId,
        projectPath,
        label: "First Lane",
      }),
      service.createCheckoutWorkstream({
        projectId,
        projectPath,
        label: "Second Lane",
      }),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof WorkstreamOperationInProgressError,
      ),
    ).toBe(true);
  });

  it("serializes concurrent upserts and preserves insertion order", async () => {
    const service = await createService();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.upsertWorkstream(
          makeWorkstream({
            id: `ws-${index}` as WorkstreamId,
            label: `stream ${index}`,
          }),
        ),
      ),
    );

    const reloaded = await createService();

    expect(reloaded.listStored().map((workstream) => workstream.id)).toEqual([
      "ws-0",
      "ws-1",
      "ws-2",
      "ws-3",
      "ws-4",
    ]);
  });

  it("removes the backing file when the last stored workstream is deleted", async () => {
    const service = await createService();
    await service.upsertWorkstream(makeWorkstream());

    await expect(fs.access(filePath)).resolves.toBeUndefined();

    await expect(
      service.deleteWorkstream("ws-tools" as WorkstreamId),
    ).resolves.toBe(true);
    expect(service.listStored()).toEqual([]);
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits change events after successful mutations", async () => {
    const eventBus = new EventBus();
    const listener = vi.fn();
    eventBus.subscribe((event) => {
      if (event.type === "workstreams-changed") {
        listener(`${event.reason}:${event.workstreamId ?? ""}`);
      }
    });
    const service = await createService(eventBus);

    await service.upsertWorkstream(makeWorkstream());
    await service.upsertWorkstream(makeWorkstream({ label: "renamed" }));
    await service.deleteWorkstream("ws-tools" as WorkstreamId);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls.map((call) => call[0])).toEqual([
      "created:ws-tools",
      "updated:ws-tools",
      "deleted:ws-tools",
    ]);
  });

  it("emits change events for projects emptied by replaceAll", async () => {
    const eventBus = new EventBus();
    const listener = vi.fn();
    eventBus.subscribe((event) => {
      if (event.type === "workstreams-changed") {
        listener(`${event.reason}:${event.projectId}`);
      }
    });
    const service = await createService(eventBus);
    await service.upsertWorkstream(makeWorkstream());
    listener.mockClear();

    await service.replaceAll([]);

    expect(listener.mock.calls.map((call) => call[0])).toEqual([
      `replaced:${projectId}`,
    ]);
    expect(service.listStored()).toEqual([]);
  });

  it("rejects invalid caller mutations without changing current state", async () => {
    const service = await createService();
    await service.upsertWorkstream(makeWorkstream());

    await expect(
      service.upsertWorkstream(
        makeWorkstream({ id: mainWorkstreamId(projectId) }),
      ),
    ).rejects.toBeInstanceOf(WorkstreamValidationError);

    await expect(
      service.upsertWorkstream(
        makeWorkstream({
          projectId: toUrlProjectId("/tmp/other-workstreams-project"),
        }),
      ),
    ).rejects.toBeInstanceOf(WorkstreamValidationError);

    await expect(
      service.replaceAll([
        makeWorkstream({ id: "ws-a" as WorkstreamId }),
        makeWorkstream({ id: "ws-a" as WorkstreamId }),
      ]),
    ).rejects.toBeInstanceOf(WorkstreamValidationError);

    expect(service.listStored().map((workstream) => workstream.id)).toEqual([
      "ws-tools",
    ]);
  });
});
