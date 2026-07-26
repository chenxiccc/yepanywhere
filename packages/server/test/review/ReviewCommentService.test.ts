import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReviewCommentService,
  type ReviewCommentServiceOptions,
} from "../../src/review/ReviewCommentService.js";

const execFileAsync = promisify(execFile);

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

/** A service with a fixed clock and counter ids, for stable assertions. */
function makeService(extra: ReviewCommentServiceOptions = {}) {
  let n = 0;
  return new ReviewCommentService({
    now: () => "2026-07-26T12:00:00.000Z",
    newId: () => `id-${++n}`,
    ...extra,
  });
}

describe("ReviewCommentService", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a pending comment and lists it", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, {
      anchor: anchor(),
      text: "why?",
    });
    expect(created).toMatchObject({
      id: "id-1",
      text: "why?",
      status: "pending",
      createdAt: "2026-07-26T12:00:00.000Z",
    });
    const pending = await svc.listPending(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("id-1");
  });

  it("writes to {projectPath}/.yep/review-comments.json", async () => {
    const svc = makeService();
    await svc.addComment(dir, { anchor: anchor(), text: "x" });
    const raw = await readFile(
      join(dir, ".yep", "review-comments.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.comments).toHaveLength(1);
  });

  it("keeps two projects' drafts isolated", async () => {
    const other = await mkdtemp(join(tmpdir(), "yep-review-b-"));
    try {
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "in A" });
      expect(await svc.listComments(other)).toHaveLength(0);
      await svc.addComment(other, { anchor: anchor(), text: "in B" });
      expect(await svc.listComments(dir)).toHaveLength(1);
      expect(await svc.listComments(other)).toHaveLength(1);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("updates a pending comment's text; refuses unknown/archived", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, { anchor: anchor(), text: "a" });
    const updated = await svc.updateComment(dir, created.id, { text: "b" });
    expect(updated?.text).toBe("b");
    expect(await svc.updateComment(dir, "nope", { text: "z" })).toBeNull();

    await svc.archiveComments(dir, {
      commentIds: [created.id],
      targetSessionId: "sess-1",
    });
    // archived comments are frozen
    expect(await svc.updateComment(dir, created.id, { text: "c" })).toBeNull();
  });

  it("deletes a pending comment; delete is idempotent-false after", async () => {
    const svc = makeService();
    const created = await svc.addComment(dir, { anchor: anchor(), text: "a" });
    expect(await svc.deleteComment(dir, created.id)).toBe(true);
    expect(await svc.listComments(dir)).toHaveLength(0);
    expect(await svc.deleteComment(dir, created.id)).toBe(false);
  });

  it("archives pending comments into a batch that records its target", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, { anchor: anchor(), text: "one" });
    const c2 = await svc.addComment(dir, { anchor: anchor(), text: "two" });

    const batch = await svc.archiveComments(dir, {
      commentIds: [c1.id, c2.id],
      targetSessionId: "sess-42",
    });
    expect(batch.targetSessionId).toBe("sess-42");
    expect(batch.commentIds.sort()).toEqual([c1.id, c2.id].sort());

    expect(await svc.listPending(dir)).toHaveLength(0);
    const all = await svc.listComments(dir);
    for (const comment of all) {
      expect(comment.status).toBe("archived");
      expect(comment.batchId).toBe(batch.id);
      expect(comment.targetSessionId).toBe("sess-42");
      expect(comment.archivedAt).toBe("2026-07-26T12:00:00.000Z");
    }

    const file = await svc.getFile(dir);
    expect(file.batches).toHaveLength(1);
  });

  it("archive consumes only currently-pending ids", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, { anchor: anchor(), text: "one" });
    await svc.archiveComments(dir, {
      commentIds: [c1.id],
      targetSessionId: "s1",
    });
    // Re-archiving the same (now archived) id consumes nothing.
    const second = await svc.archiveComments(dir, {
      commentIds: [c1.id, "ghost"],
      targetSessionId: "s2",
    });
    expect(second.commentIds).toEqual([]);
    // c1 stays with its original batch/target.
    const c1After = await svc.getComment(dir, c1.id);
    expect(c1After?.targetSessionId).toBe("s1");
  });

  it("survives a service restart (state persisted, cache dropped)", async () => {
    const svc = makeService();
    const c1 = await svc.addComment(dir, {
      anchor: anchor(),
      text: "persist me",
    });
    await svc.archiveComments(dir, {
      commentIds: [c1.id],
      targetSessionId: "s1",
    });

    // A brand-new instance = fresh in-memory cache, same files on disk.
    const restarted = makeService();
    const all = await restarted.listComments(dir);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("archived");
    expect((await restarted.getFile(dir)).batches).toHaveLength(1);
  });

  it("degrades a corrupt drafts file to an empty store", async () => {
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      "{ not valid json",
      "utf-8",
    );
    const svc = makeService();
    expect(await svc.listComments(dir)).toEqual([]);
    // and it can recover by writing fresh state
    await svc.addComment(dir, { anchor: anchor(), text: "fresh" });
    expect(await svc.listComments(dir)).toHaveLength(1);
  });

  describe("git exclude on first visit", () => {
    async function initRepo(repoDir: string): Promise<void> {
      await execFileAsync("git", ["-C", repoDir, "init"]);
    }
    async function readExclude(repoDir: string): Promise<string> {
      try {
        return await readFile(
          join(repoDir, ".git", "info", "exclude"),
          "utf-8",
        );
      } catch {
        return "";
      }
    }

    it("excludes .yep/ when it creates the dir in a git repo", async () => {
      await initRepo(dir);
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "x" });
      expect(await readExclude(dir)).toContain(".yep/");
    });

    it("leaves an existing .yep/ alone (respects a user un-exclude)", async () => {
      await initRepo(dir);
      // Simulate a project that deliberately keeps .yep/ (dir already present,
      // not excluded): the service must not add an exclude entry.
      await mkdir(join(dir, ".yep"), { recursive: true });
      const svc = makeService();
      await svc.addComment(dir, { anchor: anchor(), text: "x" });
      expect(await readExclude(dir)).not.toContain(".yep/");
    });

    it("does not fail draft writes outside a git repo", async () => {
      const svc = makeService();
      await expect(
        svc.addComment(dir, { anchor: anchor(), text: "x" }),
      ).resolves.toBeTruthy();
    });
  });
});
