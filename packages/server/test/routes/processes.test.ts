import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionIndexService } from "../../src/indexes/index.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createApp } from "../../src/app.js";
import { createProcessesRoutes } from "../../src/routes/processes.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import {
  SessionConfigurationConflictError,
  type Supervisor,
} from "../../src/supervisor/Supervisor.js";
import type {
  ProcessInfo,
  Project,
  SessionSummary,
} from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.sessions",
    activeOwnedCount: 1,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "codex",
  };
}

function createProcessInfo(): ProcessInfo {
  return {
    id: "proc-1",
    sessionId: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    projectPath: "/tmp/project",
    projectName: "project",
    sessionTitle: null,
    state: "in-turn",
    startedAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    queueDepth: 0,
    provider: "codex",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Fix the agents page titles",
    fullTitle: "Fix the agents page titles",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
  };
}

describe("Processes Routes", () => {
  it.each(["config", "model"])(
    "returns conflict when %s cannot change an active process",
    async (route) => {
      const reconfigureProcess = vi.fn(async () => {
        throw new SessionConfigurationConflictError(["service tier"]);
      });
      const routes = createProcessesRoutes({
        supervisor: {
          getProcess: vi.fn(() => ({})),
          reconfigureProcess,
        } as unknown as Supervisor,
        scanner: {} as ProjectScanner,
        readerFactory: vi.fn(),
      });

      const response = await routes.request(`/proc-1/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error:
          "Cannot apply launch-scoped configuration while the session is active: service tier",
      });
    },
  );

  it("does not acknowledge configuration whose persistence fails", async () => {
    const routes = createProcessesRoutes({
      supervisor: {
        getProcess: vi.fn(() => ({})),
        reconfigureProcess: vi.fn(async () => {
          throw new Error("metadata unavailable");
        }),
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
    });

    const response = await routes.request("/proc-1/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opus" }),
    });

    expect(response.status).toBe(500);
  });

  it("returns PID shutdown verification for an aborted process", async () => {
    const abortProcessWithVerification = vi.fn(async () => ({
      processId: "proc-1",
      sessionId: "sess-1",
      pid: 43210,
      verifiedStopped: true as const,
      verification: "pid" as const,
    }));
    const routes = createProcessesRoutes({
      supervisor: {
        abortProcessWithVerification,
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
    });

    const response = await routes.request("/proc-1/abort", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      aborted: true,
      processId: "proc-1",
      sessionId: "sess-1",
      pid: 43210,
      verifiedStopped: true,
      verification: "pid",
    });
  });

  it("exempts the session from auto-resume when the kill opts in", async () => {
    const abortProcessWithVerification = vi.fn(async () => ({
      processId: "proc-1",
      sessionId: "sess-1",
      pid: 43210,
      verifiedStopped: true as const,
      verification: "pid" as const,
    }));
    const blockSessionResume = vi.fn(async () => ({
      heartbeatDisabled: true,
      autoResumeDisabled: true,
    }));
    const routes = createProcessesRoutes({
      supervisor: {
        abortProcessWithVerification,
        getProcess: vi.fn(() => ({
          sessionId: "sess-1",
          provider: "codex",
        })),
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      blockSessionResume,
    });

    const response = await routes.request("/proc-1/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockResume: true }),
    });

    expect(response.status).toBe(200);
    expect(blockSessionResume).toHaveBeenCalledWith({
      sessionId: "sess-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      resumeExemption: {
        heartbeatDisabled: true,
        autoResumeDisabled: true,
      },
    });
  });

  it("reports when shutdown succeeds but the resume exemption fails", async () => {
    const routes = createProcessesRoutes({
      supervisor: {
        abortProcessWithVerification: vi.fn(async () => ({
          processId: "proc-1",
          sessionId: "sess-1",
          pid: 43210,
          verifiedStopped: true as const,
          verification: "pid" as const,
        })),
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      blockSessionResume: vi.fn(async () => {
        throw new Error("metadata is read-only");
      }),
    });

    const response = await routes.request("/proc-1/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockResume: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      verifiedStopped: true,
      resumeExemption: {
        heartbeatDisabled: false,
        autoResumeDisabled: false,
        error: "metadata is read-only",
      },
    });
  });

  it("does not touch resume state on a plain abort", async () => {
    const blockSessionResume = vi.fn();
    const routes = createProcessesRoutes({
      supervisor: {
        abortProcessWithVerification: vi.fn(async () => ({
          processId: "proc-1",
          sessionId: "sess-1",
          verifiedStopped: true as const,
          verification: "provider" as const,
        })),
        getProcess: vi.fn(() => ({
          sessionId: "sess-1",
          provider: "codex",
        })),
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      blockSessionResume,
    });

    const response = await routes.request("/proc-1/abort", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(blockSessionResume).not.toHaveBeenCalled();
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("resumeExemption");
  });

  it("reports a failed shutdown verification instead of claiming success", async () => {
    const routes = createProcessesRoutes({
      supervisor: {
        abortProcessWithVerification: vi.fn(async () => {
          throw new Error("Provider PID 43210 is still running after abort");
        }),
      } as unknown as Supervisor,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
    });

    const response = await routes.request("/proc-1/abort", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Provider PID 43210 is still running after abort",
      processId: "proc-1",
      verifiedStopped: false,
    });
  });

  it("falls back to the live summary title when the index lookup misses", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const summary = createSummary();

    const getSessionSummary = vi.fn(async () => summary);
    const getSessionSummaryWithCache = vi.fn(async () => null);

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary,
          }) as unknown as ISessionReader,
      ),
      sessionIndexService: {
        getSessionSummaryWithCache,
        getSessionTitle: vi.fn(async () => null),
      } as unknown as SessionIndexService,
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/?includeTerminated=true");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");
    expect(json.terminatedProcesses).toEqual([]);

    expect(getSessionSummaryWithCache).toHaveBeenCalledWith(
      "/tmp/project/.sessions",
      "proj-1",
      "sess-1",
      expect.anything(),
    );
    expect(getSessionSummary).toHaveBeenCalledWith("sess-1", "proj-1");
  });

  it("attaches provider child work to its canonical parent process", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const summary = createSummary();
    const listProviderChildSessions = vi.fn(async () => [
      {
        id: "child-native-1",
        parentSessionId: "sess-1",
        title: "Review the restart guard",
        agentType: "reviewer",
        toolUseId: "call-spawn-1",
        updatedAt: "2026-03-10T09:46:30.000Z",
      },
    ]);

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => summary),
            listProviderChildSessions,
          }) as unknown as ISessionReader,
      ),
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processes: [
        {
          sessionId: "sess-1",
          providerChildren: [
            {
              id: "child-native-1",
              parentSessionId: "sess-1",
              title: "Review the restart guard",
            },
          ],
        },
      ],
    });
    expect(listProviderChildSessions).toHaveBeenCalledWith("sess-1");
  });

  it("does not wait for decorative provider child refreshes", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const summary = createSummary();
    const listAcceptedProviderChildSessions = vi.fn(() => []);
    const listProviderChildSessions = vi.fn(async () => {
      throw new Error("fresh child discovery must not block process rows");
    });
    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => summary),
            listAcceptedProviderChildSessions,
            listProviderChildSessions,
          }) as unknown as ISessionReader,
      ),
    });

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processes: [{ sessionId: "sess-1" }],
    });
    expect(listAcceptedProviderChildSessions).toHaveBeenCalledWith("sess-1");
    expect(listProviderChildSessions).not.toHaveBeenCalled();
  });

  it("prefers persisted custom titles over generated session titles", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const summary = createSummary();

    const getSessionSummary = vi.fn(async () => summary);
    const getMetadata = vi.fn(() => ({
      customTitle: "Use this custom title",
    }));

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary,
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata,
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Use this custom title");
    expect(getMetadata).toHaveBeenCalledWith("sess-1");
  });

  it("wires app session metadata into process title enrichment", async () => {
    const project = createProject();
    const process = createProcessInfo();
    const getMetadata = vi.fn(() => ({
      customTitle: "Wired custom title",
    }));

    const { app, supervisor, scanner } = createApp({
      sdk: new MockClaudeSDK(),
      sessionIndexService: {
        getSessionSummaryWithCache: vi.fn(async () => createSummary()),
        getSessionTitle: vi.fn(async () => "Generated title"),
      } as unknown as SessionIndexService,
      sessionMetadataService: {
        getProvider: vi.fn(() => undefined),
        getMetadata,
      } as unknown as SessionMetadataService,
    });

    vi.spyOn(supervisor, "getProcessInfoList").mockReturnValue([process]);
    vi.spyOn(scanner, "getProject").mockResolvedValue(project);

    const response = await app.request("/api/processes");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Wired custom title");
    expect(getMetadata).toHaveBeenCalledWith("sess-1");
  });

  it("uses the process provider session source for mixed-provider projects", async () => {
    const project = {
      ...createProject(),
      provider: "claude",
      sessionDir: "/tmp/project/.claude-sessions",
    } satisfies Project;
    const process = createProcessInfo();
    const summary = createSummary();

    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;
    const getSessionSummaryWithCache = vi.fn(async () => summary);

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      processSessionSourceFactory: vi.fn(() => ({
        reader: codexReader,
        sessionDir: "/tmp/codex-sessions",
      })),
      sessionIndexService: {
        getSessionSummaryWithCache,
        getSessionTitle: vi.fn(async () => null),
      } as unknown as SessionIndexService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");

    expect(getSessionSummaryWithCache).toHaveBeenCalledWith(
      "/tmp/codex-sessions",
      "proj-1",
      "sess-1",
      codexReader,
    );
    expect(vi.mocked(codexReader.getSessionSummary)).not.toHaveBeenCalled();
    expect(vi.mocked(claudeReader.getSessionSummary)).not.toHaveBeenCalled();
  });

  it("prefers persisted session provider over stale process provider for display", async () => {
    const project = {
      ...createProject(),
      provider: "claude",
      sessionDir: "/tmp/project/.claude-sessions",
    } satisfies Project;
    const process = {
      ...createProcessInfo(),
      provider: "claude",
    } satisfies ProcessInfo;
    const summary = createSummary();

    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
        getRecentlyTerminatedProcesses: vi.fn(() => []),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => null),
          }) as unknown as ISessionReader,
      ),
      processSessionSourceFactory: vi.fn(() => ({
        reader: codexReader,
        sessionDir: "/tmp/codex-sessions",
      })),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ provider: "codex" })),
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0]?.sessionTitle).toBe("Fix the agents page titles");
    expect(json.processes[0]?.provider).toBe("codex");
  });

  it("keeps the canonical Gateway provider over transcript inference", async () => {
    const project = {
      ...createProject(),
      provider: "claude-gateway",
    } satisfies Project;
    const process = {
      ...createProcessInfo(),
      provider: "claude-gateway",
    } satisfies ProcessInfo;
    const summary = {
      ...createSummary(),
      provider: "claude-ollama",
      model: "gpt-5.6-terra",
    } satisfies SessionSummary;

    const routes = createProcessesRoutes({
      supervisor: {
        getProcessInfoList: vi.fn(() => [process]),
      } as unknown as Supervisor,
      scanner: {
        getProject: vi.fn(async () => project),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(
        () =>
          ({
            getSessionSummary: vi.fn(async () => summary),
          }) as unknown as ISessionReader,
      ),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
      } as unknown as SessionMetadataService,
    });

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processes: [
        {
          sessionId: "sess-1",
          provider: "claude-gateway",
          model: "gpt-5.6-terra",
        },
      ],
    });
  });
});
