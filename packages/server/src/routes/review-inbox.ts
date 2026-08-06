/** Global unread source-review outcomes for the Inbox surface. */

import { Hono } from "hono";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ReviewCommentService } from "../review/ReviewCommentService.js";

/** Backstop for project-set changes, which publish no review event yet. */
const DEFAULT_PROJECT_SET_TTL_MS = 5_000;
const MAX_REVIEW_INBOX_RETARGETS = 4;

interface ReviewInboxProjection {
  items: Array<Record<string, unknown>>;
}

export interface ReviewInboxDeps {
  scanner: Pick<ProjectScanner, "listProjects">;
  service: Pick<ReviewCommentService, "getStoreFile" | "getStateRevision">;
  isEnabled: () => boolean;
  projectSetTtlMs?: number;
  now?: () => number;
}

export function createReviewInboxRoutes(deps: ReviewInboxDeps): Hono {
  const routes = new Hono();
  const now = deps.now ?? Date.now;
  const ttlMs = Math.max(0, deps.projectSetTtlMs ?? DEFAULT_PROJECT_SET_TTL_MS);
  // One owner per server: concurrent mounts, manual refreshes, and repeated
  // review-response events share a single build instead of each starting an
  // all-project store load.
  const projections = new SourceVersionedSingleFlight<
    string,
    ReviewInboxProjection
  >({
    maxRetainedBytes: 4 * 1024 * 1024,
    estimateBytes: (value) => 256 + JSON.stringify(value.items).length,
  });
  let uncachedGeneration = 0;

  const currentSourceVersion = (): string => {
    const projectSetVersion =
      ttlMs > 0 ? String(Math.floor(now() / ttlMs)) : "uncached";
    return `${deps.service.getStateRevision()}:${projectSetVersion}`;
  };

  const buildProjection = async (): Promise<ReviewInboxProjection> => {
    const projects = await deps.scanner.listProjects();
    const items = (
      await Promise.all(
        projects.map(async (project) => {
          const store = await deps.service.getStoreFile(project.path);
          return store.submissions.flatMap((submission) =>
            submission.responseRevision > submission.acknowledgedRevision
              ? [
                  {
                    projectId: project.id,
                    projectName: project.name,
                    submissionId: submission.id,
                    name: submission.name,
                    targetSessionId: submission.targetSessionId,
                    responseRevision: submission.responseRevision,
                    outcomes: submission.entryRefs.flatMap((ref) => {
                      const site = store.sites.find(
                        (item) => item.id === ref.siteId,
                      );
                      const outcome = site?.outcomes
                        .filter((item) => item.entryId === ref.entryId)
                        .at(-1);
                      return site && outcome
                        ? [{ ...outcome, siteId: site.id, path: site.path }]
                        : [];
                    }),
                  },
                ]
              : [],
          );
        }),
      )
    )
      .flat()
      .sort(
        (left, right) =>
          (right.responseRevision as number) -
          (left.responseRevision as number),
      );
    return { items };
  };

  routes.get("/review/inbox", async (c) => {
    if (!deps.isEnabled()) {
      return c.json(
        { error: "Source-review submissions are not enabled" },
        409,
      );
    }
    // Every accepted mutation bumps the revision. The coarse time bucket is the
    // backstop for a project appearing with review state already on disk, which
    // publishes no review event today. A zero TTL deliberately gives each
    // request a distinct, unretained version while revision freshness remains
    // testable at completion.
    let projection: ReviewInboxProjection | undefined;
    for (let attempt = 0; attempt < MAX_REVIEW_INBOX_RETARGETS; attempt += 1) {
      const observedVersion = currentSourceVersion();
      const sourceVersion =
        ttlMs > 0
          ? observedVersion
          : `${observedVersion}:request-${++uncachedGeneration}`;
      const result = await projections.run({
        key: "review-inbox",
        sourceVersion,
        compute: buildProjection,
        isCurrent: () => observedVersion === currentSourceVersion(),
      });
      if (result.status !== "stale") {
        projection = result.value;
        break;
      }
      if (
        result.previous &&
        result.previous.sourceVersion === currentSourceVersion()
      ) {
        projection = result.previous.value;
        break;
      }
      // The source moved during the build. Re-admit against the newest version;
      // this hits or joins that generation when another caller already owns it.
    }
    if (!projection) {
      throw new Error("Review Inbox source version kept changing");
    }
    const items = projection.items;

    // Filtering serializes a subset of the retained projection; it never
    // builds a separate per-project projection from canonical stores.
    const projectId = c.req.query("projectId");
    return c.json({
      items: projectId
        ? items.filter((item) => item.projectId === projectId)
        : items,
    });
  });

  return routes;
}
