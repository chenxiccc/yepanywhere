import {
  MAX_HEARTBEAT_TURN_TEXT_LENGTH,
  type ProjectSessionDefaultsResponse,
  type UpdateProjectSessionDefaultsRequest,
  type UrlProjectId,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectMetadataService } from "../metadata/index.js";
import type { ProjectScanner } from "../projects/scanner.js";

export interface ProjectSessionDefaultsDeps {
  scanner: ProjectScanner;
  projectMetadataService: ProjectMetadataService;
}

function responseForProject(
  projectId: UrlProjectId,
  projectMetadataService: ProjectMetadataService,
): ProjectSessionDefaultsResponse {
  const saved = projectMetadataService.getProjectSessionDefaults(projectId);
  return {
    projectId,
    overrides: {
      heartbeatTurnsAfterMinutes: saved?.heartbeatTurnsAfterMinutes ?? null,
      heartbeatTurnText: saved?.heartbeatTurnText ?? null,
    },
    recentHeartbeatTurnTexts: saved?.recentHeartbeatTurnTexts ?? [],
  };
}

function parsePatch(
  body: unknown,
):
  | { ok: true; value: UpdateProjectSessionDefaultsRequest }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object" };
  }
  const raw = body as Record<string, unknown>;
  if (
    raw.heartbeatTurnsAfterMinutes === undefined &&
    raw.heartbeatTurnText === undefined
  ) {
    return {
      ok: false,
      error: "At least one project session default must be provided",
    };
  }

  const value: UpdateProjectSessionDefaultsRequest = {};
  if (raw.heartbeatTurnsAfterMinutes !== undefined) {
    if (raw.heartbeatTurnsAfterMinutes === null) {
      value.heartbeatTurnsAfterMinutes = null;
    } else if (
      typeof raw.heartbeatTurnsAfterMinutes === "number" &&
      Number.isInteger(raw.heartbeatTurnsAfterMinutes) &&
      raw.heartbeatTurnsAfterMinutes >= 1 &&
      raw.heartbeatTurnsAfterMinutes <= 1440
    ) {
      value.heartbeatTurnsAfterMinutes = raw.heartbeatTurnsAfterMinutes;
    } else {
      return {
        ok: false,
        error:
          "heartbeatTurnsAfterMinutes must be null or an integer between 1 and 1440",
      };
    }
  }

  if (raw.heartbeatTurnText !== undefined) {
    if (raw.heartbeatTurnText === null) {
      value.heartbeatTurnText = null;
    } else if (typeof raw.heartbeatTurnText === "string") {
      const text = raw.heartbeatTurnText.trim();
      if (!text) {
        return {
          ok: false,
          error: "heartbeatTurnText must be null or a non-empty string",
        };
      }
      if (text.length > MAX_HEARTBEAT_TURN_TEXT_LENGTH) {
        return {
          ok: false,
          error: `heartbeatTurnText must be at most ${MAX_HEARTBEAT_TURN_TEXT_LENGTH} characters`,
        };
      }
      value.heartbeatTurnText = text;
    } else {
      return {
        ok: false,
        error: "heartbeatTurnText must be null or a string",
      };
    }
  }

  return { ok: true, value };
}

export function createProjectSessionDefaultsRoutes(
  deps: ProjectSessionDefaultsDeps,
): Hono {
  const routes = new Hono();

  routes.get("/:projectId/session-defaults", async (c) => {
    const rawProjectId = c.req.param("projectId");
    if (!isUrlProjectId(rawProjectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(rawProjectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(responseForProject(project.id, deps.projectMetadataService));
  });

  routes.patch("/:projectId/session-defaults", async (c) => {
    const rawProjectId = c.req.param("projectId");
    if (!isUrlProjectId(rawProjectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const project = await deps.scanner.getOrCreateProject(rawProjectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const parsed = parsePatch(await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    await deps.projectMetadataService.updateProjectSessionDefaults(
      project.id,
      parsed.value,
    );
    return c.json(responseForProject(project.id, deps.projectMetadataService));
  });

  return routes;
}
