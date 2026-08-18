import type { GitRevisionComparison } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  compareFiles,
  gitError,
  type GitProjectionDeps,
  isValidProjectionSha,
  renderComparisonDiff,
  resolveCommit,
} from "./git-projection-diff.js";
import { resolveProjectPath } from "./projectParam.js";

/** Direct selected-revision-tree-to-pinned-HEAD projections. */
export function createGitProjectionRoutes(deps: GitProjectionDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git/compare/:sha", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const requestedBase = c.req.param("sha");
    if (!isValidProjectionSha(requestedBase)) {
      return c.json({ error: "Invalid commit id" }, 400);
    }

    try {
      const [baseSha, headSha] = await Promise.all([
        resolveCommit(projectPath, requestedBase),
        resolveCommit(projectPath, "HEAD"),
      ]);
      const files = await compareFiles(projectPath, baseSha, headSha);
      return c.json({
        baseSha,
        headSha,
        files,
      } satisfies GitRevisionComparison);
    } catch (err) {
      return gitError(c, err);
    }
  });

  routes.post("/:projectId/git/compare-diff", (c) =>
    renderComparisonDiff(c, deps, false),
  );

  return routes;
}
