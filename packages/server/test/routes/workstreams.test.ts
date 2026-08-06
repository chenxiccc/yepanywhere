import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type StoredWorkstream,
  type UrlProjectId,
  type WorkstreamId,
  mainWorkstreamId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createWorkstreamRoutes } from "../../src/routes/workstreams.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { WorkstreamService } from "../../src/services/WorkstreamService.js";
import type { Project } from "../../src/supervisor/types.js";

const NOW = "2026-07-05T10:00:00.000Z";
const execFileAsync = promisify(execFile);

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

describe("Workstream Routes", () => {
  let testDir: string;
  let projectPath: string;
  let projectId: UrlProjectId;
  let project: Project;
  let workstreamService: WorkstreamService;
  let scanner: Pick<ProjectScanner, "getOrCreateProject">;
  let workstreamsEnabled: boolean;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "workstream-routes-"));
    projectPath = path.join(testDir, "workstream-route-project");
    projectId = toUrlProjectId(projectPath);
    project = {
      id: projectId,
      path: projectPath,
      name: "workstream-route-project",
      sessionCount: 0,
      sessionDir: "/tmp/workstream-route-project/.claude-sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    scanner = {
      getOrCreateProject: vi.fn(async (id) =>
        id === projectId ? project : null,
      ),
    };
    workstreamsEnabled = true;
    workstreamService = new WorkstreamService({
      dataDir: testDir,
      now: () => new Date(NOW),
    });
    await workstreamService.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function createRoutes() {
    const serverSettingsService = {
      getSetting: vi.fn((key: string) =>
        key === "workstreamsEnabled" ? workstreamsEnabled : undefined,
      ),
    } as unknown as ServerSettingsService;

    return createWorkstreamRoutes({
      scanner: scanner as ProjectScanner,
      serverSettingsService,
      workstreamService,
    });
  }

  function makeWorkstream(
    overrides: Partial<StoredWorkstream> = {},
  ): StoredWorkstream {
    return {
      id: "ws-tools" as WorkstreamId,
      projectId,
      label: "tools cleanup",
      kind: "checkout",
      path: path.join(testDir, "workstream-route-project-tools"),
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

  it("hides the route when workstreams are disabled", async () => {
    workstreamsEnabled = false;

    const response = await createRoutes().request(`/${projectId}/workstreams`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Workstreams are not enabled",
    });
    expect(scanner.getOrCreateProject).not.toHaveBeenCalled();
  });

  it("rejects invalid project ids", async () => {
    const response = await createRoutes().request("/not a project/workstreams");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid project ID format",
    });
  });

  it("returns not found for unknown projects", async () => {
    const missingProjectId = toUrlProjectId("/tmp/missing-workstream-project");

    const response = await createRoutes().request(
      `/${missingProjectId}/workstreams`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
  });

  it("returns the implicit main workstream", async () => {
    const response = await createRoutes().request(`/${projectId}/workstreams`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId,
      workstreams: [
        {
          id: mainWorkstreamId(projectId),
          projectId,
          label: "main",
          kind: "main",
          path: projectPath,
          branch: "main",
          baseBranch: "main",
          baseCommit: null,
          managedByYa: false,
          queuePaused: false,
          status: "active",
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns stored checkout lanes after the implicit main workstream", async () => {
    await workstreamService.upsertWorkstream(makeWorkstream());

    const response = await createRoutes().request(`/${projectId}/workstreams`);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(
      json.workstreams.map((workstream: { id: string }) => workstream.id),
    ).toEqual([mainWorkstreamId(projectId), "ws-tools"]);
    expect(json.workstreams[1]).toMatchObject({
      id: "ws-tools",
      projectId,
      label: "tools cleanup",
      kind: "checkout",
      path: path.join(testDir, "workstream-route-project-tools"),
      branch: "main",
      managedByYa: true,
    });
  });

  it("previews the checkout destination for a label", async () => {
    await initGitProject(projectPath);

    const response = await createRoutes().request(
      `/${projectId}/workstreams/checkout-preview?label=Feature%20Lane`,
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      projectId,
      label: "Feature Lane",
      slug: "feature-lane",
    });
    expect(json.checkoutRootPath).toBe(
      path.join(
        testDir,
        "checkouts",
        `workstream-route-project-${shortProjectHash(projectId)}`,
        "feature-lane",
      ),
    );
    expect(json.checkoutPath).toBe(json.checkoutRootPath);
  });

  it("creates a checkout lane and returns the refreshed workstream list", async () => {
    await initGitProject(projectPath);
    await fs.writeFile(
      path.join(projectPath, ".worktreeinclude"),
      ".env.local\n",
    );
    await fs.writeFile(path.join(projectPath, ".env.local"), "local=true\n");

    const response = await createRoutes().request(`/${projectId}/workstreams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Feature Lane" }),
    });

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.workstream).toMatchObject({
      projectId,
      label: "Feature Lane",
      kind: "checkout",
      branch: "main",
      managedByYa: true,
    });
    await expect(
      fs.access(path.join(json.workstream.path, ".git")),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(json.workstream.path, ".env.local"), "utf-8"),
    ).resolves.toBe("local=true\n");
    expect(
      json.workstreams.map((workstream: { kind: string }) => workstream.kind),
    ).toEqual(["main", "checkout"]);
  });

  it("returns a clear conflict when a checkout operation is already running", async () => {
    await initGitProject(projectPath);
    const routes = createRoutes();

    const responses = await Promise.all([
      routes.request(`/${projectId}/workstreams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "First Lane" }),
      }),
      routes.request(`/${projectId}/workstreams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Second Lane" }),
      }),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(await conflict?.json()).toEqual({
      error: "A workstream operation is already running for this project",
      code: "operation_in_progress",
    });
  });

  it("rejects checkout creation when the project is not a git repository", async () => {
    await fs.mkdir(projectPath, { recursive: true });

    const response = await createRoutes().request(`/${projectId}/workstreams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Feature Lane" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Project is not a Git repository",
      code: "not_git_repository",
    });
  });
});
