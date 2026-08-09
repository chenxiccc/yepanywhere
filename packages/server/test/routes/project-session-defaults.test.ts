import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { ProjectMetadataService } from "../../src/metadata/index.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectSessionDefaultsRoutes } from "../../src/routes/project-session-defaults.js";

function createDeps() {
  const projectId = toUrlProjectId("/tmp/project");
  const getProjectSessionDefaults = vi.fn(() => undefined);
  const updateProjectSessionDefaults = vi.fn(async () => undefined);
  return {
    projectId,
    getProjectSessionDefaults,
    updateProjectSessionDefaults,
    routes: createProjectSessionDefaultsRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => ({
          id: projectId,
          path: "/tmp/project",
          name: "project",
        })),
      } as unknown as ProjectScanner,
      projectMetadataService: {
        getProjectSessionDefaults,
        updateProjectSessionDefaults,
      } as unknown as ProjectMetadataService,
    }),
  };
}

describe("project session defaults routes", () => {
  it("returns explicit inheritance markers", async () => {
    const { routes, projectId } = createDeps();

    const response = await routes.request(`/${projectId}/session-defaults`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId,
      overrides: {
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: null,
      },
      recentHeartbeatTurnTexts: [],
    });
  });

  it("normalizes and persists project overrides", async () => {
    const deps = createDeps();
    deps.getProjectSessionDefaults.mockReturnValue({
      heartbeatTurnsAfterMinutes: 30,
      heartbeatTurnText: "keep going",
      recentHeartbeatTurnTexts: ["keep going"],
      updatedAt: "2026-08-09T00:00:00.000Z",
    });

    const response = await deps.routes.request(
      `/${deps.projectId}/session-defaults`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          heartbeatTurnsAfterMinutes: 30,
          heartbeatTurnText: "  keep going  ",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(deps.updateProjectSessionDefaults).toHaveBeenCalledWith(
      deps.projectId,
      {
        heartbeatTurnsAfterMinutes: 30,
        heartbeatTurnText: "keep going",
      },
    );
  });

  it("rejects invalid intervals", async () => {
    const { routes, projectId, updateProjectSessionDefaults } = createDeps();

    const response = await routes.request(`/${projectId}/session-defaults`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heartbeatTurnsAfterMinutes: 0 }),
    });

    expect(response.status).toBe(400);
    expect(updateProjectSessionDefaults).not.toHaveBeenCalled();
  });

  it("rejects heartbeat messages over the shared limit", async () => {
    const { routes, projectId, updateProjectSessionDefaults } = createDeps();

    const response = await routes.request(`/${projectId}/session-defaults`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heartbeatTurnText: "x".repeat(2_001) }),
    });

    expect(response.status).toBe(400);
    expect(updateProjectSessionDefaults).not.toHaveBeenCalled();
  });
});
