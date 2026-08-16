import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectMetadataService } from "../../src/metadata/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectsRoutes } from "../../src/routes/projects.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex project session",
    fullTitle: "Codex project session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

function createProcess(
  projectId: UrlProjectId,
  options: {
    state?: { type: "idle" | "in-turn" | "waiting-input" };
    queueDepth?: number;
    retainingProviderWork?: boolean;
    deferredQueueDepth?: number;
    pendingInput?: unknown;
    livenessStatus?: string;
  } = {},
) {
  return {
    projectId,
    state: options.state ?? { type: "idle" },
    queueDepth: options.queueDepth ?? 0,
    isRetainingProviderWork: vi.fn(
      () => options.retainingProviderWork ?? false,
    ),
    getDeferredQueueSummary: vi.fn(() =>
      Array.from({ length: options.deferredQueueDepth ?? 0 }, () => ({})),
    ),
    getPendingInputRequest: vi.fn(() => options.pendingInput ?? null),
    getLivenessSnapshot: vi.fn(() => ({
      derivedStatus: options.livenessStatus ?? "verified-idle",
    })),
  };
}

describe("Projects Routes", () => {
  it("enriches project list responses with Project Queue counts", async () => {
    const project = createProject();
    const routes = createProjectsRoutes({
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectQueueService: {
        listAll: vi.fn(() => [
          {
            id: "queue-1",
            projectId: project.id,
            target: { type: "new-session" },
            messagePreview: "Queued session",
            message: { text: "Queued session" },
            createdAt: "2026-03-10T09:45:00.000Z",
            updatedAt: "2026-03-10T09:45:00.000Z",
            status: "queued",
            attachmentCount: 0,
          },
          {
            id: "queue-2",
            projectId: project.id,
            target: { type: "existing-session", sessionId: "sess-1" },
            messagePreview: "Sending now",
            message: { text: "Sending now" },
            createdAt: "2026-03-10T09:46:00.000Z",
            updatedAt: "2026-03-10T09:46:00.000Z",
            status: "dispatching",
            attachmentCount: 0,
          },
          {
            id: "queue-3",
            projectId: project.id,
            target: { type: "existing-session", sessionId: "sess-2" },
            messagePreview: "Needs retry",
            message: { text: "Needs retry" },
            createdAt: "2026-03-10T09:47:00.000Z",
            updatedAt: "2026-03-10T09:47:00.000Z",
            status: "failed",
            attachmentCount: 0,
          },
        ]),
        listProject: vi.fn(),
      } as unknown as Parameters<
        typeof createProjectsRoutes
      >[0]["projectQueueService"],
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.projects[0]).toMatchObject({
      id: project.id,
      projectQueueCount: 2,
    });
  });

  it("lists mixed-provider sessions through the shared provider resolver", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      listSessions: vi.fn(async () => []),
      listProviderChildSessions: vi.fn(async () => []),
    } as unknown as ISessionReader;
    const children = [
      {
        id: "child-1",
        parentSessionId: "sess-1",
        title: "Review the restart guard",
        updatedAt: "2026-08-16T12:00:00.000Z",
      },
    ];
    const listProviderChildSessions = vi.fn(async () => {
      throw new Error("list reads must not cold-parse Codex children");
    });
    const codexReader = {
      listSessions: vi.fn(async () => [summary]),
      listAcceptedProviderChildSessions: vi.fn(() => children),
      listProviderChildSessions,
    } as unknown as ISessionReader;

    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexScanner: {
        listProjects: vi.fn(async () => [{ ...project, provider: "codex" }]),
      } as unknown as NonNullable<
        Parameters<typeof createProjectsRoutes>[0]["codexScanner"]
      >,
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
      sessionAutoArchiveDays: 0,
    });

    const response = await routes.request("/proj-1/sessions");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]).toMatchObject({
      id: "sess-1",
      title: "Codex project session",
      provider: "codex",
      providerChildren: children,
    });
    expect(listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("enriches single-project responses with live activity counts", async () => {
    const project = {
      ...createProject(),
      id: toUrlProjectId("/tmp/project"),
    };
    const routes = createProjectsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      supervisor: {
        getAllProcesses: vi.fn(() => [
          createProcess(project.id),
          createProcess(project.id, { state: { type: "in-turn" } }),
          createProcess(toUrlProjectId("/tmp/other"), {
            state: { type: "in-turn" },
          }),
        ]),
        getQueueInfo: vi.fn(() => []),
      } as unknown as Parameters<typeof createProjectsRoutes>[0]["supervisor"],
      externalTracker: {
        getExternalSessions: vi.fn(() => ["external-1", "external-2"]),
        getExternalSessionInfoWithUrlId: vi
          .fn()
          .mockResolvedValueOnce({
            projectId: project.id,
            lastActivity: new Date("2026-03-10T09:47:00.000Z"),
          })
          .mockResolvedValueOnce({
            projectId: toUrlProjectId("/tmp/other"),
            lastActivity: new Date("2026-03-10T09:48:00.000Z"),
          }),
      } as unknown as Parameters<
        typeof createProjectsRoutes
      >[0]["externalTracker"],
    });

    const response = await routes.request(`/${project.id}`);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.project).toMatchObject({
      id: project.id,
      activeOwnedCount: 2,
      activeExternalCount: 1,
      projectQueueBlockingCount: 2,
    });
  });

  it("hides a project from YA lists", async () => {
    const project = {
      ...createProject(),
      id: toUrlProjectId("/tmp/project"),
    };
    const scanner = {
      getProject: vi.fn(async () => project),
      invalidateCache: vi.fn(),
    } as unknown as ProjectScanner;
    const projectMetadataService = {
      hideProject: vi.fn(async () => {}),
    } as unknown as ProjectMetadataService;

    const routes = createProjectsRoutes({
      scanner,
      readerFactory: vi.fn(),
      projectMetadataService,
    });

    const response = await routes.request(`/${project.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json).toMatchObject({
      removed: true,
      projectId: project.id,
      path: project.path,
    });
    expect(projectMetadataService.hideProject).toHaveBeenCalledWith(
      project.id,
      project.path,
    );
    expect(scanner.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when hiding an unknown project", async () => {
    const routes = createProjectsRoutes({
      scanner: {
        getProject: vi.fn(async () => null),
        invalidateCache: vi.fn(),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(),
      projectMetadataService: {
        hideProject: vi.fn(async () => {}),
      } as unknown as ProjectMetadataService,
    });

    const response = await routes.request(
      `/${toUrlProjectId("/tmp/missing")}`,
      {
        method: "DELETE",
      },
    );
    expect(response.status).toBe(404);
  });
});
