import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReviewCaptureService,
  SOURCE_REVIEW_CAPTURE_REF,
} from "../../src/review/ReviewCaptureService.js";
import { repositoryRelativePath } from "../../src/review/repositoryPath.js";

const execFileAsync = promisify(execFile);

describe("ReviewCaptureService", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "yep-review-capture-"));
    await execFileAsync("git", ["-C", repo, "init"]);
    await execFileAsync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "file.ts"), "const committed = 1;\n");
    await execFileAsync("git", ["-C", repo, "add", "--", "src/file.ts"]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "fixture"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("captures committed and dirty projections as pinned blobs", async () => {
    const service = new ReviewCaptureService();
    const { stdout: head } = await execFileAsync("git", [
      "-C",
      repo,
      "rev-parse",
      "HEAD",
    ]);
    const committed = await service.capture(repo, {
      kind: "revision",
      revision: head.trim(),
      path: "src/file.ts",
      side: "old",
    });
    expect(committed.status).toBe("captured");

    await writeFile(join(repo, "src", "file.ts"), "const dirty = 2;\n");
    const dirty = await service.capture(repo, {
      kind: "worktree",
      path: "src/file.ts",
      side: "new",
    });
    expect(dirty.status).toBe("captured");
    if (committed.status !== "captured" || dirty.status !== "captured") return;
    expect(dirty.captureBlobId).not.toBe(committed.captureBlobId);

    const { stdout: treeEntries } = await execFileAsync("git", [
      "-C",
      repo,
      "ls-tree",
      "--name-only",
      SOURCE_REVIEW_CAPTURE_REF,
    ]);
    expect(treeEntries.trim().split("\n").sort()).toEqual(
      [committed.captureBlobId, dirty.captureBlobId].sort(),
    );
    const { stdout: dirtyBytes } = await execFileAsync("git", [
      "-C",
      repo,
      "cat-file",
      "blob",
      dirty.captureBlobId,
    ]);
    expect(dirtyBytes).toBe("const dirty = 2;\n");

    const excerpt = await service.readExcerpt(repo, dirty, {
      path: "src/file.ts",
      revision: { kind: "uncommitted", savedAt: new Date().toISOString() },
      side: "new",
      oldLine: 1,
      newLine: 1,
      snippet: "const dirty = 2;",
    });
    expect(excerpt).toMatchObject({
      status: "captured",
      content: "const dirty = 2;\n",
      startLine: 1,
      highlightLine: 1,
    });

    const comparisonAnchor = {
      path: "src/file.ts",
      revision: {
        kind: "uncommitted" as const,
        savedAt: new Date().toISOString(),
      },
      side: "new" as const,
      oldLine: 1,
      newLine: 1,
      snippet: "const dirty = 2;",
    };
    await writeFile(join(repo, "src", "file.ts"), "const   dirty=2;\n");
    await expect(
      service.compareNeighborhood(repo, dirty, comparisonAnchor),
    ).resolves.toBe("unchanged");
    await writeFile(join(repo, "src", "file.ts"), "const dirty = 3;\n");
    await expect(
      service.compareNeighborhood(repo, dirty, comparisonAnchor),
    ).resolves.toBe("changed");

    await service.pin(repo, dirty.captureBlobId);
    await execFileAsync("git", ["-C", repo, "gc", "--prune=now"]);
    await expect(
      execFileAsync("git", ["-C", repo, "cat-file", "-e", dirty.captureBlobId]),
    ).resolves.toBeTruthy();
  });

  it("rejects absolute, traversal, and escaping symlink paths", async () => {
    for (const invalid of [
      "/etc/passwd",
      "../outside",
      "src/../../outside",
      "C:\\outside",
    ]) {
      expect(() => repositoryRelativePath(invalid)).toThrow();
    }

    const outside = await mkdtemp(join(tmpdir(), "yep-review-outside-"));
    try {
      await writeFile(join(outside, "secret.ts"), "secret\n");
      await symlink(join(outside, "secret.ts"), join(repo, "src", "escape.ts"));
      const service = new ReviewCaptureService();
      await expect(
        service.capture(repo, {
          kind: "worktree",
          path: "src/escape.ts",
          side: "new",
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
