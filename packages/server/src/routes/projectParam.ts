import { isUrlProjectId } from "@yep-anywhere/shared";
import type { Context } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";

/**
 * Resolve a route's `:projectId` param to its filesystem path, or the error
 * Response to return as-is. The one validation + lookup shared by the
 * project-scoped route files (git browse, review comments, ...).
 */
export async function resolveProjectPath(
  c: Context,
  scanner: ProjectScanner,
): Promise<string | Response> {
  const projectId = c.req.param("projectId");
  if (!projectId || !isUrlProjectId(projectId)) {
    return c.json({ error: "Invalid project ID format" }, 400);
  }
  const project = await scanner.getProject(projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);
  return project.path;
}
