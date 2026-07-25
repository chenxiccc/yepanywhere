import { toUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
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
    bangHistoryViewEnabled: vi.fn(() => true),
    sessionBelongsToProject: vi.fn(async () => false),
  } as unknown as BangCommandsDeps;
  return { deps, bangCommandService };
}

describe("bang command project/session boundary", () => {
  it("keeps execution and completions available while only the history view is hidden", async () => {
    const { deps, bangCommandService } = createDeps();
    deps.bangHistoryViewEnabled = vi.fn(() => false);
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
      app.request(`/projects/${projectId}/bang-completions?token=git`),
      app.request("/bang-commands"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 404,
    ]);
    expect(bangCommandService.run).toHaveBeenCalled();
    expect(bangCommandService.kill).toHaveBeenCalled();
    expect(bangCommandService.readOutput).toHaveBeenCalled();
  });

  it("does not intercept unrelated API routes while the history view is hidden", async () => {
    const { deps } = createDeps();
    deps.bangHistoryViewEnabled = vi.fn(() => false);
    const app = new Hono();
    app.route("/api", createBangCommandsRoutes(deps));
    app.get("/api/projects/:projectId/files", (c) =>
      c.json({ route: "files" }),
    );

    const response = await app.request(`/api/projects/${projectId}/files`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ route: "files" });
  });

  it("runs when the project/session boundary allows it", async () => {
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

describe("bang completions global command history", () => {
  const bang = (id: string, command: string, createdAt: string) => ({
    id,
    kind: "bang-command" as const,
    createdAt,
    placementAfterMessageId: "",
    command,
    cwd: "/project-a",
    status: "done" as const,
    exitCode: 0,
  });

  function depsWithHistory() {
    const { deps } = createDeps();
    // Two sessions' worth of bang objects, out of createdAt order and with a
    // duplicate "git status" (older + newer) to exercise dedup.
    deps.sessionMetadataService.listTranscriptDisplayObjectSessions = vi.fn(
      () => [
        {
          sessionId: "s1",
          workingProjectId: projectId,
          objects: [
            bang("b1", "git status", "2026-07-24T00:00:00.000Z"),
            bang("b2", "git log --oneline", "2026-07-24T02:00:00.000Z"),
          ],
        },
        {
          sessionId: "s2",
          workingProjectId: projectId,
          objects: [
            bang("b3", "git status", "2026-07-24T03:00:00.000Z"),
            bang("b4", "ls -la", "2026-07-24T01:00:00.000Z"),
            bang("b5", "git status -s", "2026-07-24T04:00:00.000Z"),
          ],
        },
      ],
    );
    return deps;
  }

  it("returns prefix-matched history, most-recent-first and deduped", async () => {
    const app = createBangCommandsRoutes(depsWithHistory());
    const response = await app.request(
      `/projects/${projectId}/bang-completions?token=zznomatch&kind=command&line=${encodeURIComponent(
        "git ",
      )}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { history: string[] };
    expect(body.history).toEqual([
      "git status -s",
      "git status",
      "git log --oneline",
    ]);
  });

  it("excludes the command exactly equal to the current body", async () => {
    const app = createBangCommandsRoutes(depsWithHistory());
    const response = await app.request(
      `/projects/${projectId}/bang-completions?token=zznomatch&kind=command&line=${encodeURIComponent(
        "git status",
      )}`,
    );
    const body = (await response.json()) as { history: string[] };
    expect(body.history).toEqual(["git status -s"]);
  });

  it("returns empty history when the line is empty", async () => {
    const app = createBangCommandsRoutes(depsWithHistory());
    const response = await app.request(
      `/projects/${projectId}/bang-completions?token=git&kind=command`,
    );
    const body = (await response.json()) as { history: string[] };
    expect(body.history).toEqual([]);
  });
});
