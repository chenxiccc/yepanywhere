import {
  GLOSSARY_SOURCE_PATH_MAX_LENGTH,
  type GlossaryArtifactResponse,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  GlossaryIndexService,
  type GlossaryResolutionResult,
} from "../projects/glossaryIndexService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveProjectPath } from "./projectParam.js";

export interface GlossaryArtifactRoutesDeps {
  scanner: ProjectScanner;
  service?: GlossaryIndexService;
}

export function createGlossaryArtifactRoutes(
  deps: GlossaryArtifactRoutesDeps,
): Hono {
  const routes = new Hono();
  const service = deps.service ?? new GlossaryIndexService();

  routes.get("/:projectId/glossary-artifact", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const sourcePath = c.req.query("sourcePath");
    if (sourcePath !== undefined && sourcePath.length === 0) {
      return c.json({ error: "sourcePath must not be empty" }, 400);
    }
    if (
      sourcePath !== undefined &&
      sourcePath.length > GLOSSARY_SOURCE_PATH_MAX_LENGTH
    ) {
      return c.json(
        {
          error: `sourcePath exceeds ${GLOSSARY_SOURCE_PATH_MAX_LENGTH} characters`,
        },
        400,
      );
    }

    const result: GlossaryResolutionResult = await service.resolve(
      projectPath,
      sourcePath,
    );
    if (result.status === "none" && result.reason === "invalid-source-path") {
      return c.json({ error: "sourcePath must be project-relative" }, 400);
    }
    return c.json(result satisfies GlossaryArtifactResponse);
  });

  return routes;
}
