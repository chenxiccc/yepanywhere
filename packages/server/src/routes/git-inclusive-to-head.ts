import type { GitInclusiveRevisionComparison } from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  compareFiles,
  gitError,
  type GitProjectionDeps,
  isValidProjectionSha,
  renderComparisonDiff,
  resolveCommit,
  resolveFirstParentOrEmptyTree,
} from "./git-projection-diff.js";
import { resolveProjectPath } from "./projectParam.js";

/** Inclusive selected-commit-through-pinned-HEAD projections. */
export function createGitInclusiveToHeadRoutes(deps: GitProjectionDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git/range-to-head/:sha", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const requestedSelected = c.req.param("sha");
    if (!isValidProjectionSha(requestedSelected)) {
      return c.json({ error: "Invalid commit id" }, 400);
    }

    try {
      const [selectedSha, headSha] = await Promise.all([
        resolveCommit(projectPath, requestedSelected),
        resolveCommit(projectPath, "HEAD"),
      ]);
      const baseSha = await resolveFirstParentOrEmptyTree(
        projectPath,
        selectedSha,
      );
      const files = await compareFiles(projectPath, baseSha, headSha);
      return c.json({
        selectedSha,
        baseSha,
        headSha,
        files,
      } satisfies GitInclusiveRevisionComparison);
    } catch (err) {
      return gitError(c, err);
    }
  });

  routes.post("/:projectId/git/range-to-head-diff", (c) =>
    renderComparisonDiff(c, deps, true),
  );

  return routes;
}
