import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type BangCommandsDeps,
  createBangCommandsRoutes,
} from "../../src/routes/bang-commands.js";

const projectId = toUrlProjectId("/project-a");
const sessionId = "session-in-project-b";
const object = {
  id: "bang-1",
  kind: "bang-command" as const,
  createdAt: "2026-07-24T00:00:00.000Z",
  placementAfterMessageId: "",
  command: "pwd",
  cwd: "/project-a",
  status: "done" as const,
  exitCode: 0,
};

function createDeps() {
  const bangCommandService = {
    run: vi.fn(async () => ({ object, completion: Promise.resolve(object) })),
    kill: vi.fn(() => true),
    readOutput: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      responseTruncated: false,
    })),
    remove: vi.fn(async () => true),
  };
  const deps = {
    scanner: {
      getOrCreateProject: vi.fn(async () => ({
        id: projectId,
        path: "/project-a",
      })),
    },
    sessionMetadataService: {
      getTranscriptDisplayObjects: vi.fn(() => [object]),
      listTranscriptDisplayObjectSessions: vi.fn(() => []),
    },
    bangCommandService,
    bangCommandsEnabled: vi.fn(() => true),
    sessionBelongsToProject: vi.fn(async () => false),
  } as unknown as BangCommandsDeps;
  return { deps, bangCommandService };
}

describe("bang command project/session boundary", () => {
  it("keeps every command route unavailable until explicitly enabled", async () => {
    const { deps, bangCommandService } = createDeps();
    deps.bangCommandsEnabled = vi.fn(() => false);
    deps.sessionBelongsToProject = vi.fn(async () => true);
    const app = createBangCommandsRoutes(deps);
    const prefix = `/projects/${projectId}/sessions/${sessionId}/bang-commands`;

    const responses = await Promise.all([
      app.request(prefix, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      }),
      app.request(`${prefix}/${object.id}/kill`, { method: "POST" }),
      app.request(`${prefix}/${object.id}/output`),
      app.request(`${prefix}/${object.id}`, { method: "DELETE" }),
      app.request(`/projects/${projectId}/bang-completions?token=git`),
      app.request("/bang-commands"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404,
    ]);
    expect(bangCommandService.run).not.toHaveBeenCalled();
    expect(bangCommandService.kill).not.toHaveBeenCalled();
    expect(bangCommandService.readOutput).not.toHaveBeenCalled();
    expect(bangCommandService.remove).not.toHaveBeenCalled();
  });

  it("runs only after the feature and project/session boundary both allow it", async () => {
    const { deps, bangCommandService } = createDeps();
    deps.sessionBelongsToProject = vi.fn(async () => true);
    const app = createBangCommandsRoutes(deps);
    const response = await app.request(
      `/projects/${projectId}/sessions/${sessionId}/bang-commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      },
    );

    expect(response.status).toBe(200);
    expect(bangCommandService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        projectPath: "/project-a",
        command: "pwd",
      }),
    );
  });

  it("rejects every session-scoped operation under the wrong project", async () => {
    const { deps, bangCommandService } = createDeps();
    const app = createBangCommandsRoutes(deps);
    const prefix = `/projects/${projectId}/sessions/${sessionId}/bang-commands`;

    const responses = await Promise.all([
      app.request(prefix, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      }),
      app.request(`${prefix}/${object.id}/kill`, { method: "POST" }),
      app.request(`${prefix}/${object.id}/output`),
      app.request(`${prefix}/${object.id}`, { method: "DELETE" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404,
    ]);
    expect(bangCommandService.run).not.toHaveBeenCalled();
    expect(bangCommandService.kill).not.toHaveBeenCalled();
    expect(bangCommandService.readOutput).not.toHaveBeenCalled();
    expect(bangCommandService.remove).not.toHaveBeenCalled();
  });
});
