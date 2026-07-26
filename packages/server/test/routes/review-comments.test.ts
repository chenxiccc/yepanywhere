import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ReviewComment,
  type ReviewCommentAnchor,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import { createReviewCommentsRoutes } from "../../src/routes/review-comments.js";
import type { Project } from "../../src/supervisor/types.js";

function projectFor(projectPath: string): Project {
  return {
    id: toUrlProjectId(projectPath),
    path: projectPath,
    name: "repo",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

/** Scanner that resolves any of the given projects by url id. */
function scannerFor(...projects: Project[]): ProjectScanner {
  return {
    async getProject(id: string) {
      return projects.find((p) => p.id === id) ?? null;
    },
  } as unknown as ProjectScanner;
}

function anchor(
  overrides: Partial<ReviewCommentAnchor> = {},
): ReviewCommentAnchor {
  return {
    path: "src/a.ts",
    revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 12,
    snippet: "added line",
    ...overrides,
  };
}

describe("review-comments routes", () => {
  let dir: string;
  let projectId: string;
  let routes: ReturnType<typeof createReviewCommentsRoutes>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-route-"));
    const project = projectFor(dir);
    projectId = project.id;
    routes = createReviewCommentsRoutes({
      scanner: scannerFor(project),
      service: new ReviewCommentService(),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    return routes.request(`/${projectId}/review/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates, lists, updates, and deletes a comment", async () => {
    const createRes = await post({ anchor: anchor(), text: "why this?" });
    expect(createRes.status).toBe(201);
    const { comment } = (await createRes.json()) as { comment: ReviewComment };
    expect(comment.text).toBe("why this?");
    expect(comment.status).toBe("pending");

    const listRes = await routes.request(`/${projectId}/review/comments`);
    const list = (await listRes.json()) as {
      comments: ReviewComment[];
      pendingCount: number;
    };
    expect(list.comments).toHaveLength(1);
    expect(list.pendingCount).toBe(1);

    const patchRes = await routes.request(
      `/${projectId}/review/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "clarify naming" }),
      },
    );
    expect(patchRes.status).toBe(200);
    expect(
      ((await patchRes.json()) as { comment: ReviewComment }).comment.text,
    ).toBe("clarify naming");

    const delRes = await routes.request(
      `/${projectId}/review/comments/${comment.id}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);

    const afterList = (await (
      await routes.request(`/${projectId}/review/comments`)
    ).json()) as { pendingCount: number };
    expect(afterList.pendingCount).toBe(0);
  });

  it("rejects an invalid anchor and empty text", async () => {
    expect((await post({ anchor: { path: "" }, text: "x" })).status).toBe(400);
    expect((await post({ anchor: anchor(), text: "   " })).status).toBe(400);
    expect((await post({ anchor: anchor() })).status).toBe(400);
  });

  it("404s updating or deleting an unknown comment", async () => {
    const patch = await routes.request(`/${projectId}/review/comments/nope`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "z" }),
    });
    expect(patch.status).toBe(404);
    const del = await routes.request(`/${projectId}/review/comments/nope`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("404s an unknown project and 400s a malformed id", async () => {
    const unknown = toUrlProjectId(join(tmpdir(), "not-a-registered-project"));
    const res = await routes.request(`/${unknown}/review/comments`);
    expect(res.status).toBe(404);

    const bad = await routes.request("/!!!bad!!!/review/comments");
    expect(bad.status).toBe(400);
  });

  it("keeps two projects' comments isolated", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "yep-review-route-b-"));
    try {
      const projectA = projectFor(dir);
      const projectB = projectFor(otherDir);
      const shared = new ReviewCommentService();
      const isoRoutes = createReviewCommentsRoutes({
        scanner: scannerFor(projectA, projectB),
        service: shared,
      });

      await isoRoutes.request(`/${projectA.id}/review/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: anchor(), text: "A only" }),
      });

      const bList = (await (
        await isoRoutes.request(`/${projectB.id}/review/comments`)
      ).json()) as { pendingCount: number };
      expect(bList.pendingCount).toBe(0);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});
