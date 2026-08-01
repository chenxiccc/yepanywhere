import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ReviewComment,
  type ReviewCommentAnchor,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import type { ReviewSessionLauncher } from "../../src/review/reviewSessionLauncher.js";
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
  let project: Project;
  let service: ReviewCommentService;
  let routes: ReturnType<typeof createReviewCommentsRoutes>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-route-"));
    project = projectFor(dir);
    projectId = project.id;
    service = new ReviewCommentService();
    routes = createReviewCommentsRoutes({
      scanner: scannerFor(project),
      service,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Routes sharing this test's service, plus a submit launcher stub. */
  function routesWithLauncher(launcher: ReviewSessionLauncher) {
    return createReviewCommentsRoutes({
      scanner: scannerFor(project),
      service,
      launcher,
    });
  }

  async function writeProjectFile(rel: string, text: string): Promise<void> {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf-8");
  }

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

  it("accepts capture identity only when submissions are enabled", async () => {
    const projected = anchor({
      projection: {
        kind: "worktree",
        path: "src/a.ts",
        side: "new",
      },
    });
    const disabledResponse = await post({ anchor: projected, text: "off" });
    const disabled = (await disabledResponse.json()) as {
      comment: ReviewComment;
    };
    expect(disabled.comment.anchor.projection).toBeUndefined();

    const enabledRoutes = createReviewCommentsRoutes({
      scanner: scannerFor(project),
      service,
      isSubmissionsEnabled: () => true,
    });
    const enabledResponse = await enabledRoutes.request(
      `/${projectId}/review/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: projected, text: "on" }),
      },
    );
    const enabled = (await enabledResponse.json()) as {
      comment: ReviewComment;
    };
    expect(enabled.comment.anchor.projection).toEqual(projected.projection);
  });

  it("rejects an invalid anchor and empty text", async () => {
    expect((await post({ anchor: { path: "" }, text: "x" })).status).toBe(400);
    expect(
      (await post({ anchor: anchor({ path: "../outside.ts" }), text: "x" }))
        .status,
    ).toBe(400);
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

  const startsLauncher: ReviewSessionLauncher = {
    async startReviewSession() {
      return { status: "started", sessionId: "new-sess" };
    },
    async deliverFollowUp() {
      return { status: "delivered" };
    },
  };

  interface PreviewBody {
    items: Array<{
      comment: ReviewComment;
      relocation: { status: "relocated" | "gone" };
      defaultDiscard: boolean;
    }>;
    pendingCount: number;
  }

  it("preview relocates present lines and lists gone comments first", async () => {
    await writeProjectFile("src/present.ts", "a\nb\nconst kept = 1;\nc\n");
    // A comment on a line that still exists → relocated.
    await service.addComment(dir, {
      anchor: anchor({
        path: "src/present.ts",
        newLine: 3,
        snippet: "const kept = 1;",
        snippetAnchorOffset: 0,
      }),
      text: "present",
    });
    // A comment on a missing file → gone.
    await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts", snippet: "nope" }),
      text: "gone",
    });

    const res = await routes.request(`/${projectId}/review/preview`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.pendingCount).toBe(2);
    // Gone first, pre-selected discard.
    expect(body.items[0]?.relocation.status).toBe("gone");
    expect(body.items[0]?.defaultDiscard).toBe(true);
    expect(body.items[1]?.relocation.status).toBe("relocated");
    expect(body.items[1]?.defaultDiscard).toBe(false);
  });

  it("submit to a new session archives the batch against it", async () => {
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "look here",
    });
    const res = await routesWithLauncher(startsLauncher).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include: [c.id], target: "new" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      consumed: string[];
    };
    expect(body.sessionId).toBe("new-sess");
    expect(body.consumed).toEqual([c.id]);

    const archived = await service.getComment(dir, c.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.targetSessionId).toBe("new-sess");
    expect(await service.listPending(dir)).toHaveLength(0);
  });

  it("quotes relocated context in the turn for a dirty-line comment", async () => {
    await writeProjectFile(
      "src/dirty.ts",
      "current before\nconst clicked = 1;\ncurrent after",
    );
    let deliveredTurn = "";
    const launcher: ReviewSessionLauncher = {
      async startReviewSession(_projectPath, turn) {
        deliveredTurn = turn;
        return { status: "started", sessionId: "new-sess" };
      },
      async deliverFollowUp() {
        return { status: "delivered" };
      },
    };
    const c = await service.addComment(dir, {
      anchor: anchor({
        path: "src/dirty.ts",
        newLine: 20,
        snippet: "draft before\nconst clicked = 1;\ndraft after",
        snippetAnchorOffset: 1,
      }),
      text: "check this dirty line",
    });

    const res = await routesWithLauncher(launcher).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include: [c.id], target: "new" }),
      },
    );

    expect(res.status).toBe(200);
    expect(deliveredTurn).toContain("src/dirty.ts:2");
    expect(deliveredTurn).toContain(
      "```\ncurrent before\nconst clicked = 1;\ncurrent after\n```",
    );
    expect(deliveredTurn).toContain("Read the current file state");
  });

  it("passes the origin session's model settings to a new review session", async () => {
    let launchOptions: unknown;
    const launcher: ReviewSessionLauncher = {
      async startReviewSession(_projectPath, _text, options) {
        launchOptions = options;
        return { status: "started", sessionId: "new-sess" };
      },
      async deliverFollowUp() {
        return { status: "delivered" };
      },
    };
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "look here",
    });

    const res = await routesWithLauncher(launcher).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          include: [c.id],
          target: "new",
          newSession: {
            provider: "codex",
            model: "gpt-5.4",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(launchOptions).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });
  });

  it("submit as a follow-up delivers to an existing session id", async () => {
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "round 2",
    });
    const res = await routesWithLauncher(startsLauncher).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include: [c.id], target: "existing-sess" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessionId: string }).sessionId).toBe(
      "existing-sess",
    );
  });

  it("leaves comments pending when a follow-up is queued at capacity", async () => {
    const queuedFollowUp: ReviewSessionLauncher = {
      startReviewSession: startsLauncher.startReviewSession,
      async deliverFollowUp() {
        return { status: "queued" };
      },
    };
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "x",
    });
    const res = await routesWithLauncher(queuedFollowUp).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include: [c.id], target: "dead-sess" }),
      },
    );
    // Enqueued, not delivered → 202, comments still pending for a retry.
    expect(res.status).toBe(202);
    expect(await service.listPending(dir)).toHaveLength(1);
  });

  it("submit leaves comments pending when the session is queued", async () => {
    const queuedLauncher: ReviewSessionLauncher = {
      async startReviewSession() {
        return { status: "queued" };
      },
      async deliverFollowUp() {
        return { status: "delivered" };
      },
    };
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "x",
    });
    const res = await routesWithLauncher(queuedLauncher).request(
      `/${projectId}/review/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ include: [c.id], target: "new" }),
      },
    );
    expect(res.status).toBe(202);
    expect(await service.listPending(dir)).toHaveLength(1);
  });

  it("submit validates include and target, and 501s without a launcher", async () => {
    const c = await service.addComment(dir, {
      anchor: anchor({ path: "src/missing.ts" }),
      text: "x",
    });
    const withLauncher = routesWithLauncher(startsLauncher);
    const submit = (payload: unknown) =>
      withLauncher.request(`/${projectId}/review/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    expect((await submit({ include: [], target: "new" })).status).toBe(400);
    expect((await submit({ include: [c.id] })).status).toBe(400);
    expect(
      (
        await submit({
          include: [c.id],
          target: "new",
          newSession: { provider: "not-real" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await submit({
          include: [c.id],
          target: "existing",
          newSession: { provider: "codex" },
        })
      ).status,
    ).toBe(400);
    expect((await submit({ include: ["ghost"], target: "new" })).status).toBe(
      400,
    );

    // No launcher configured → 501.
    const res = await routes.request(`/${projectId}/review/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ include: [c.id], target: "new" }),
    });
    expect(res.status).toBe(501);
  });
});
