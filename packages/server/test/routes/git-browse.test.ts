import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitBlameResult,
  type GitCommitDetail,
  type GitCommitListResult,
  type GitCommitSearchManifest,
  type GitCommitSearchRecordsResult,
  type GitDiffResult,
  type GitFileListResult,
  type GitSearchResult,
  anchorFromPatch,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitBrowseRoutes } from "../../src/routes/git-browse.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

function createRoutesForProject(projectPath: string) {
  const projectId = toUrlProjectId(projectPath);
  const project: Project = {
    id: projectId,
    path: projectPath,
    name: "repo",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  return {
    projectId,
    routes: createGitBrowseRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git-browse routes", () => {
  let dir: string;
  const shas: Record<string, string> = {};

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  async function commitAll(message: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-git-browse-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");

    await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
    shas.c1 = await commitAll("add a");

    await writeFile(join(dir, "a.ts"), "line1\nline2 changed\nline3\nline4\n");
    await writeFile(join(dir, "b.ts"), "new file\n");
    shas.c2 = await commitAll("modify a add b");

    // Rename a.ts -> d.ts with a small edit so -M detects it as a rename.
    await rename(join(dir, "a.ts"), join(dir, "d.ts"));
    await writeFile(
      join(dir, "d.ts"),
      "line1\nline2 changed\nline3\nline4\nline5\n",
    );
    shas.c3 = await commitAll("rename a to d");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists commits newest-first with paging", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const page = await routes.request(`/${projectId}/git/commits?limit=2`);
    const body = (await page.json()) as GitCommitListResult;

    expect(page.status).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(body.commits).toHaveLength(2);
    expect(body.commits[0]?.subject).toBe("rename a to d");
    expect(body.commits[0]?.hash).toBe(shas.c3);
    expect(body.commits[1]?.subject).toBe("modify a add b");

    const rest = await routes.request(
      `/${projectId}/git/commits?limit=2&skip=2`,
    );
    const restBody = (await rest.json()) as GitCommitListResult;
    expect(restBody.hasMore).toBe(false);
    expect(restBody.commits).toHaveLength(1);
    expect(restBody.commits[0]?.subject).toBe("add a");
  });

  it("supplies complete history and bounded records for the client index", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const manifestResponse = await routes.request(
      `/${projectId}/git/commit-search-manifest`,
    );
    const manifest = (await manifestResponse.json()) as GitCommitSearchManifest;
    expect(manifestResponse.status).toBe(200);
    expect(manifest.head).toBe(shas.c3);
    expect(manifest.commits.map((commit) => commit.hash)).toEqual([
      shas.c3,
      shas.c2,
      shas.c1,
    ]);

    const recordsResponse = await routes.request(
      `/${projectId}/git/commit-search-records`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shas: [shas.c3, shas.c2] }),
      },
    );
    const records =
      (await recordsResponse.json()) as GitCommitSearchRecordsResult;
    expect(recordsResponse.status).toBe(200);
    expect(records.records).toHaveLength(2);
    expect(records.records[0]).toMatchObject({ hash: shas.c3 });
    expect(records.records[0]?.deltaText).toContain("line5");
    expect(records.records[0]?.deltaText).toContain("d.ts");

    const oversized = await routes.request(
      `/${projectId}/git/commit-search-records`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shas: Array(21).fill(shas.c3) }),
      },
    );
    expect(oversized.status).toBe(400);
  });

  it("returns a commit's metadata and changed-file list", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit/${shas.c2}`);
    const body = (await res.json()) as GitCommitDetail;

    expect(res.status).toBe(200);
    expect(body.subject).toBe("modify a add b");
    expect(body.files).toContainEqual({
      path: "a.ts",
      status: "M",
      staged: false,
      linesAdded: 2,
      linesDeleted: 1,
    });
    expect(body.files).toContainEqual({
      path: "b.ts",
      status: "A",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    });
  });

  it("marks a rename with its original path", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit/${shas.c3}`);
    const body = (await res.json()) as GitCommitDetail;

    const renamed = body.files.find((f) => f.path === "d.ts");
    expect(renamed?.status).toBe("R");
    expect(renamed?.origPath).toBe("a.ts");
  });

  it("computes a per-file commit diff with data-diff-line addressing", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: shas.c2, path: "a.ts", status: "M" }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.diffHtml).toContain("data-diff-line");
    const lines = body.structuredPatch.flatMap((h) => h.lines);
    expect(lines).toContain("+line2 changed");
    expect(lines).toContain("-line2");

    // The flat index emitted in diffHtml must invert to the same line via the
    // shared anchor helper (the P1↔P2 contract, now for commit diffs).
    const addedFlat = lines.indexOf("+line2 changed");
    const anchor = anchorFromPatch(body.structuredPatch, addedFlat);
    expect(anchor?.side).toBe("new");
    expect(body.diffHtml).toContain(`data-diff-line="${addedFlat}"`);
  });

  it("can hide whitespace-only changes in a commit diff", async () => {
    await writeFile(
      join(dir, "d.ts"),
      "line1\nline2   changed\nline3\nline4\nline5\n",
    );
    const whitespaceCommit = await commitAll("adjust spacing");
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sha: whitespaceCommit,
        path: "d.ts",
        status: "M",
        ignoreWhitespace: true,
      }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    expect(body.structuredPatch).toEqual([]);
  });

  it("treats an added file as fully new (empty old side)", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: shas.c2, path: "b.ts", status: "A" }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    const lines = body.structuredPatch.flatMap((h) => h.lines);
    expect(lines).toContain("+new file");
    expect(lines.some((l) => l.startsWith("-"))).toBe(false);
  });

  it("skips binary files in commit diffs", async () => {
    await writeFile(
      join(dir, "compiled.cache"),
      Buffer.from([0x43, 0x41, 0x43, 0x48, 0, 0xff]),
    );
    const binaryCommit = await commitAll("add binary cache");
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sha: binaryCommit,
        path: "compiled.cache",
        status: "A",
      }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: { reason: "binary" },
    });
  });

  it("rejects a non-hex commit id", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const res = await routes.request(`/${projectId}/git/commit/not-a-sha`);
    expect(res.status).toBe(400);
  });

  it("blames a file with per-line commits and highlighted body", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(
      `/${projectId}/git/blame?path=${encodeURIComponent("d.ts")}`,
    );
    const body = (await res.json()) as GitBlameResult;

    expect(res.status).toBe(200);
    expect(body.lines).toHaveLength(5);
    expect(body.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5]);
    expect(body.lines[4]?.content).toBe("line5");
    // The line added by the last commit blames to it.
    expect(body.lines[4]?.sha).toBe(shas.c3);
    expect(body.lines[4]?.uncommitted).toBe(false);
    expect(body.lines[0]?.author).toBe("YA Test");
    expect(body.highlightedLanguage).toBe("typescript");
    expect(body.highlightedHtml).toContain('class="line"');
  });

  it("marks a working-tree change as uncommitted in blame", async () => {
    await writeFile(
      join(dir, "d.ts"),
      "line1\nline2 changed\nline3\nline4\nline5\nline6 wip\n",
    );
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(
      `/${projectId}/git/blame?path=${encodeURIComponent("d.ts")}`,
    );
    const body = (await res.json()) as GitBlameResult;

    const wip = body.lines.find((l) => l.content === "line6 wip");
    expect(wip?.uncommitted).toBe(true);
  });

  it("lists tracked files and filters by query", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const all = await routes.request(`/${projectId}/git/files`);
    const allBody = (await all.json()) as GitFileListResult;
    expect(allBody.files).toContain("b.ts");
    expect(allBody.files).toContain("d.ts");
    expect(allBody.truncated).toBe(false);

    const filtered = await routes.request(`/${projectId}/git/files?q=d`);
    const filteredBody = (await filtered.json()) as GitFileListResult;
    expect(filteredBody.files).toEqual(["d.ts"]);
  });

  it("returns tracked paths beyond the former 2,000-file ceiling", async () => {
    const bulkDir = join(dir, "bulk");
    await mkdir(bulkDir);
    await Promise.all(
      Array.from({ length: 2_010 }, (_, index) =>
        writeFile(
          join(bulkDir, `tracked-${index.toString().padStart(4, "0")}.txt`),
          "",
        ),
      ),
    );
    await git("add", "bulk");
    const { projectId, routes } = createRoutesForProject(dir);

    const response = await routes.request(`/${projectId}/git/files`);
    const body = (await response.json()) as GitFileListResult;
    expect(response.status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.files).toContain("bulk/tracked-2009.txt");
    expect(body.files.length).toBeGreaterThan(2_000);
  });

  it("searches filenames and commit deltas", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const byName = await routes.request(
      `/${projectId}/git/search?kind=filename&q=b.ts`,
    );
    const byNameBody = (await byName.json()) as GitSearchResult;
    expect(byNameBody.files).toContain("b.ts");

    // "line5" was introduced only by the rename commit.
    const byDelta = await routes.request(
      `/${projectId}/git/search?kind=delta&q=line5`,
    );
    const byDeltaBody = (await byDelta.json()) as GitSearchResult;
    expect(byDeltaBody.commits?.map((commit) => commit.hash)).toContain(
      shas.c3,
    );
  });
});
