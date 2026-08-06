import type {
  CreateProjectWorkstreamRequest,
  CreateProjectWorkstreamResponse,
  UrlProjectId,
  WorkstreamCheckoutPreviewResponse,
} from "@yep-anywhere/shared";
import { isUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import {
  WorkstreamCheckoutError,
  WorkstreamOperationInProgressError,
  WorkstreamValidationError,
  type WorkstreamService,
} from "../services/WorkstreamService.js";
import type { Project } from "../supervisor/types.js";

export interface WorkstreamRoutesDeps {
  scanner: ProjectScanner;
  serverSettingsService: ServerSettingsService;
  workstreamService: WorkstreamService;
}

function isWorkstreamsEnabled(
  serverSettingsService: ServerSettingsService,
): boolean {
  return serverSettingsService.getSetting("workstreamsEnabled") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function resolveProject(
  scanner: ProjectScanner,
  projectId: string,
): Promise<
  | { project: Project }
  | {
      error: "Invalid project ID format" | "Project not found";
      status: 400 | 404;
    }
> {
  if (!isUrlProjectId(projectId)) {
    return { error: "Invalid project ID format", status: 400 };
  }

  const project = await scanner.getOrCreateProject(projectId);
  if (!project) {
    return { error: "Project not found", status: 404 };
  }

  return { project };
}

function serializeWorkstreamError(error: unknown): {
  body: { error: string; code?: string; detail?: string };
  status: 400 | 409 | 500;
} {
  if (error instanceof WorkstreamOperationInProgressError) {
    return {
      status: 409,
      body: {
        error: "A workstream operation is already running for this project",
        code: error.code,
      },
    };
  }

  if (error instanceof WorkstreamCheckoutError) {
    return {
      status: error.status === 400 || error.status === 409 ? error.status : 500,
      body: {
        error: error.message,
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    };
  }

  if (error instanceof WorkstreamValidationError) {
    return {
      status: 400,
      body: { error: error.message, code: "validation_failed" },
    };
  }

  return {
    status: 500,
    body: { error: "Failed to create workstream" },
  };
}

export function createWorkstreamRoutes(deps: WorkstreamRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/workstreams", async (c) => {
    if (!isWorkstreamsEnabled(deps.serverSettingsService)) {
      return c.json({ error: "Workstreams are not enabled" }, 404);
    }

    const resolved = await resolveProject(
      deps.scanner,
      c.req.param("projectId"),
    );
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    const { project } = resolved;
    const response = {
      projectId: project.id as UrlProjectId,
      workstreams: deps.workstreamService.listProject({
        projectId: project.id,
        projectPath: project.path,
      }),
    };
    return c.json(response);
  });

  routes.get("/:projectId/workstreams/checkout-preview", async (c) => {
    if (!isWorkstreamsEnabled(deps.serverSettingsService)) {
      return c.json({ error: "Workstreams are not enabled" }, 404);
    }

    const resolved = await resolveProject(
      deps.scanner,
      c.req.param("projectId"),
    );
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    try {
      const { project } = resolved;
      const destination =
        await deps.workstreamService.previewCheckoutWorkstream({
          projectId: project.id as UrlProjectId,
          projectPath: project.path,
          projectName: project.name,
          label: c.req.query("label") ?? "",
        });
      const response: WorkstreamCheckoutPreviewResponse = {
        projectId: project.id as UrlProjectId,
        ...destination,
      };
      return c.json(response);
    } catch (error) {
      const { body, status } = serializeWorkstreamError(error);
      return c.json(body, status);
    }
  });

  routes.post("/:projectId/workstreams", async (c) => {
    if (!isWorkstreamsEnabled(deps.serverSettingsService)) {
      return c.json({ error: "Workstreams are not enabled" }, 404);
    }

    const resolved = await resolveProject(
      deps.scanner,
      c.req.param("projectId"),
    );
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    const body = await readJsonBody(c);
    if (!isRecord(body)) {
      return c.json(
        { error: "Request body must be a JSON object", code: "invalid_body" },
        400,
      );
    }

    try {
      const request = body as Partial<CreateProjectWorkstreamRequest>;
      const { project } = resolved;
      const { workstream } =
        await deps.workstreamService.createCheckoutWorkstream({
          projectId: project.id as UrlProjectId,
          projectPath: project.path,
          projectName: project.name,
          label: request.label ?? "",
        });
      const response: CreateProjectWorkstreamResponse = {
        projectId: project.id as UrlProjectId,
        workstream,
        workstreams: deps.workstreamService.listProject({
          projectId: project.id as UrlProjectId,
          projectPath: project.path,
        }),
      };
      return c.json(response, 201);
    } catch (error) {
      const { body, status } = serializeWorkstreamError(error);
      return c.json(body, status);
    }
  });

  return routes;
}
