import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { GeminiSessionScanner } from "../../src/projects/gemini-scanner.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { WorkstreamService } from "../../src/services/WorkstreamService.js";
import { encodeProjectId, type Project } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function encodePath(path: string): string {
  return path.replace(/[/\\:]/g, "-");
}

async function createClaudeProject(
  projectsDir: string,
  host: string,
  projectPath: string,
  sessionId: string,
): Promise<string> {
  const encodedPath = encodePath(projectPath);
  const sessionDir = join(projectsDir, host, encodedPath);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    `{"type":"user","cwd":"${projectPath}","message":{"content":"hello"}}\n`,
  );
  return join(host, encodedPath).replace(/\\/g, "/");
}

describe("ProjectScanner missing projectsDir", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("still discovers Codex sessions when ~/.claude/projects is missing", async () => {
    const nonExistentDir = join(
      tmpdir(),
      `project-scanner-missing-${randomUUID()}`,
    );
    // Don't create it — it should not exist

    const codexDir = join(tmpdir(), `codex-sessions-${randomUUID()}`);
    tempDirs.push(codexDir);
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-test.jsonl"),
      `{"type":"session_meta","payload":{"id":"test-session","cwd":"/home/user/codex-project","timestamp":"2025-01-01T00:00:00Z"}}\n`,
    );

    const scanner = new ProjectScanner({
      projectsDir: nonExistentDir,
      codexSessionsDir: codexDir,
      enableCodex: true,
      enableGemini: false,
    });

    const projects = await scanner.listProjects();
    // Should find at least the Codex session (possibly plus a home fallback)
    const codexProjects = projects.filter((p) => p.provider === "codex");
    expect(codexProjects.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ProjectScanner cache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reuses snapshot results until invalidated", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const first = await scanner.listProjects();
    expect(first).toHaveLength(1);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const cached = await scanner.listProjects();
    expect(cached).toHaveLength(1);

    scanner.invalidateCache();
    const refreshed = await scanner.listProjects();
    expect(refreshed).toHaveLength(2);
  });

  it("resolves a known project without refreshing stale aggregates", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const projectPath = "/home/user/project-one";

    await createClaudeProject(projectsDir, "localhost", projectPath, "sess-1");

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });
    await scanner.listProjects();

    const scanSpy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );
    scanner.invalidateCache();

    await expect(
      scanner.getProject(encodeProjectId(projectPath), {
        allowStaleSnapshot: true,
      }),
    ).resolves.toMatchObject({ path: projectPath });
    expect(scanSpy).not.toHaveBeenCalled();

    await scanner.getProject(encodeProjectId(projectPath));
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent scans into one in-flight refresh", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 0,
    });

    const spy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );

    await Promise.all([
      scanner.listProjects(),
      scanner.listProjects(),
      scanner.listProjects(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("preserves invalidation that arrives during an active scan", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const originalScan = internals.scanProjects.bind(scanner);
    let signalScanCaptured: (() => void) | null = null;
    const scanCaptured = new Promise<void>((resolve) => {
      signalScanCaptured = resolve;
    });
    let releaseScan: (() => void) | null = null;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    vi.spyOn(internals, "scanProjects").mockImplementation(async () => {
      const projects = await originalScan();
      signalScanCaptured?.();
      await scanGate;
      return projects;
    });

    const firstScan = scanner.listProjects();
    await scanCaptured;
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );
    scanner.invalidateCache();
    releaseScan?.();

    expect(await firstScan).toHaveLength(1);
    expect(await scanner.listProjects()).toHaveLength(2);
  });

  it("serializes project snapshot persistence behind the active write", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
      projectScanCachePath: join(projectsDir, "project-cache.json"),
    });
    const internals = scanner as unknown as {
      saveSnapshotToDisk: (
        snapshot: { projects: Project[] },
        revision: number,
      ) => Promise<void>;
    };
    let activeSaves = 0;
    let maxActiveSaves = 0;
    let saveCalls = 0;
    let finalSavedProjectCount = 0;
    let signalFirstSaveStarted: (() => void) | null = null;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSaveStarted = resolve;
    });
    let releaseFirstSave: (() => void) | null = null;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let signalSecondSaveDone: (() => void) | null = null;
    const secondSaveDone = new Promise<void>((resolve) => {
      signalSecondSaveDone = resolve;
    });
    vi.spyOn(internals, "saveSnapshotToDisk").mockImplementation(
      async (snapshot) => {
        saveCalls += 1;
        activeSaves += 1;
        maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
        if (saveCalls === 1) {
          signalFirstSaveStarted?.();
          await firstSaveGate;
        }
        finalSavedProjectCount = snapshot.projects.length;
        activeSaves -= 1;
        if (saveCalls === 2) signalSecondSaveDone?.();
      },
    );

    await scanner.listProjects();
    await firstSaveStarted;
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );
    scanner.invalidateCache();
    await scanner.listProjects();

    expect(saveCalls).toBe(1);
    releaseFirstSave?.();
    await secondSaveDone;
    expect(maxActiveSaves).toBe(1);
    expect(finalSavedProjectCount).toBe(2);
  });

  it("invalidates snapshot from watcher file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    await scanner.listProjects();

    const secondSuffix = await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const beforeEvent =
      await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(beforeEvent).toBeNull();

    eventBus.emit({
      type: "file-change",
      provider: "claude",
      path: join(projectsDir, secondSuffix, "sess-2.jsonl"),
      relativePath: `${secondSuffix}/sess-2.jsonl`,
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const afterEvent = await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(afterEvent?.id).toBe(encodeProjectId("/home/user/project-two"));
  });

  it("aggregates provider session counts for claude projects", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    vi.spyOn(CodexSessionScanner.prototype, "listProjects").mockResolvedValue([
      {
        id: encodeProjectId("/home/user/project-one"),
        path: "/home/user/project-one",
        name: "project-one",
        sessionCount: 3,
        sessionDir: "/codex/sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2099-01-01T00:00:00.000Z",
        provider: "codex",
      },
    ]);
    vi.spyOn(
      GeminiSessionScanner.prototype,
      "registerKnownPaths",
    ).mockResolvedValue(undefined);
    vi.spyOn(GeminiSessionScanner.prototype, "listProjects").mockResolvedValue([
      {
        id: encodeProjectId("/home/user/project-one"),
        path: "/home/user/project-one",
        name: "project-one",
        sessionCount: 2,
        sessionDir: "/gemini/tmp/project-one/chats",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2099-02-01T00:00:00.000Z",
        provider: "gemini",
      },
    ]);

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: true,
      enableGemini: true,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.provider).toBe("claude");
    expect(projects[0]).toMatchObject({
      path: "/home/user/project-one",
      sessionCount: 6,
      sessionCountsByProvider: {
        claude: 1,
        codex: 3,
        gemini: 2,
      },
      hasCodexSessions: true,
      hasGeminiSessions: true,
      lastActivity: "2099-02-01T00:00:00.000Z",
    });
  });

  it("merges Windows drive project paths that differ only by case", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    const canonicalPath = "C:/Users/sox/Documents/code/mclone";
    const lowerCasePath = "C:/Users/sox/documents/code/mclone";

    await createClaudeProject(
      projectsDir,
      "host-upper",
      canonicalPath,
      "sess-upper-1",
    );
    await createClaudeProject(
      projectsDir,
      "host-upper",
      canonicalPath,
      "sess-upper-2",
    );
    await createClaudeProject(
      projectsDir,
      "host-lower",
      lowerCasePath,
      "sess-lower-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: encodeProjectId(canonicalPath),
      path: canonicalPath,
      name: "mclone",
      sessionCount: 3,
    });

    await expect(
      scanner.getProject(encodeProjectId(lowerCasePath)),
    ).resolves.toMatchObject({
      id: encodeProjectId(canonicalPath),
      path: canonicalPath,
    });
  });

  it("keeps WSL-like project path casing distinct", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "host-upper",
      "/mnt/c/Users/sox/Documents/code/mclone",
      "sess-upper",
    );
    await createClaudeProject(
      projectsDir,
      "host-lower",
      "/mnt/c/Users/sox/documents/code/mclone",
      "sess-lower",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(2);
  });

  it("invalidates shared codex scanner cache on codex file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const codexProject = {
      id: encodeProjectId("/home/user/project-one"),
      path: "/home/user/project-one",
      name: "project-one",
      sessionCount: 1,
      sessionDir: "/codex/sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: "2025-01-01T00:00:00.000Z",
      provider: "codex" as const,
    };
    let nextProjects: (typeof codexProject)[] = [];
    let cachedProjects: (typeof codexProject)[] | null = null;
    const codexScanner = {
      listProjects: vi.fn(async () => {
        if (cachedProjects) return cachedProjects;
        cachedProjects = [...nextProjects];
        return cachedProjects;
      }),
      invalidateCache: vi.fn(() => {
        cachedProjects = null;
      }),
    } as unknown as CodexSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    const initialProjects = await scanner.listProjects();
    expect(initialProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: false,
    });

    nextProjects = [codexProject];
    eventBus.emit({
      type: "file-change",
      provider: "codex",
      path: "/codex/sessions/2025/01/01/rollout-1.jsonl",
      relativePath: "2025/01/01/rollout-1.jsonl",
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const refreshedProjects = await scanner.listProjects();
    expect(codexScanner.invalidateCache).toHaveBeenCalledTimes(1);
    expect(refreshedProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: true,
    });
  });

  it("skips hidden projects discovered from session logs", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    await metadata.hideProject(
      encodeProjectId("/home/user/project-one"),
      "/home/user/project-one",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects.some((p) => p.path === "/home/user/project-one")).toBe(
      false,
    );
  });

  it("does not reuse a stale snapshot after its project is hidden", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);
    const projectPath = "/home/user/project-one";
    const projectId = encodeProjectId(projectPath);

    await createClaudeProject(projectsDir, "localhost", projectPath, "sess-1");
    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });
    await expect(scanner.getProject(projectId)).resolves.not.toBeNull();

    await metadata.hideProject(projectId, projectPath);

    await expect(
      scanner.getProject(projectId, { allowStaleSnapshot: true }),
    ).resolves.toBeNull();
  });

  it("skips hidden Codex projects", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    await metadata.hideProject(
      encodeProjectId("/home/user/codex-project"),
      "/home/user/codex-project",
    );

    const codexScanner = {
      listProjects: vi.fn(async () => [
        {
          id: encodeProjectId("/home/user/codex-project"),
          path: "/home/user/codex-project",
          name: "codex-project",
          sessionCount: 1,
          sessionDir: "/codex/sessions",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: "2025-01-01T00:00:00.000Z",
          provider: "codex" as const,
        },
      ]),
      invalidateCache: vi.fn(),
    } as unknown as CodexSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects.some((p) => p.path === "/home/user/codex-project")).toBe(
      false,
    );
  });

  it("groups known workstream checkout cwd paths under the canonical project", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `workstream-data-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);
    const canonicalProjectPath = join(dataDir, "repo");
    const lanePath = join(dataDir, "checkouts", "repo", "feature-lane");
    await mkdir(canonicalProjectPath, { recursive: true });
    await mkdir(lanePath, { recursive: true });

    const workstreamService = new WorkstreamService({ dataDir });
    await workstreamService.initialize();
    await workstreamService.createWorkstream({
      projectId: encodeProjectId(canonicalProjectPath),
      label: "Feature lane",
      path: lanePath,
      branch: "main",
      managedByYa: true,
    });

    await createClaudeProject(projectsDir, "localhost", lanePath, "sess-lane");

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      workstreamService,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: encodeProjectId(canonicalProjectPath),
      path: canonicalProjectPath,
      name: "repo",
      sessionCount: 1,
    });

    await expect(
      scanner.getOrCreateProject(encodeProjectId(lanePath)),
    ).resolves.toMatchObject({
      id: encodeProjectId(canonicalProjectPath),
      path: canonicalProjectPath,
    });
  });
});
