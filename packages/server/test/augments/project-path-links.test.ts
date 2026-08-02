import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkifyProjectPaths } from "../../src/augments/project-path-links.js";
import { getLogger } from "../../src/logging/logger.js";
import {
  __test__,
  getProjectPathIndex,
} from "../../src/projects/projectPathIndex.js";

const execFileAsync = promisify(execFile);
const repos: string[] = [];

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ya-path-index-"));
  repos.push(dir);
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@example"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  __test__.reset();
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("project path index", () => {
  it("finds files inside gitignored directories", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "tracked.md"), "# tracked\n");
    await writeFile(join(repo, ".gitignore"), "untracked/\n");
    await execFileAsync("git", ["-C", repo, "add", "tracked.md", ".gitignore"]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "add"]);
    await mkdir(join(repo, "untracked/runs"), { recursive: true });
    await writeFile(join(repo, "untracked/runs/eval-v2.jsonl"), "{}\n");

    const index = await getProjectPathIndex(repo);

    expect(await index.has("tracked.md")).toBe(true);
    // The reported case: an agent hands over a path under an untracked
    // results directory, which `git ls-files` would never report.
    expect(await index.has("untracked/runs/eval-v2.jsonl")).toBe(true);
    expect(await index.has("does/not/exist.json")).toBe(false);
    expect(
      await linkifyProjectPaths(
        "<span>untracked/runs/eval-v2.jsonl</span>",
        { projectPath: repo, index },
      ),
    ).toContain('data-ya-resource="local-file"');
  });

  it("validates one referenced parent once per lookup batch", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(join(repo, "runs"), old, old);

    const index = await __test__.createIndex(repo, { startWarm: false });
    expect(await index.has("runs/first.json")).toBe(true);
    __test__.resetDiagnostics(index);

    const found = await index.findExisting([
      "runs/first.json",
      "runs/missing-a.json",
      "runs/missing-b.json",
    ]);

    expect(found).toEqual(new Set(["runs/first.json"]));
    expect(__test__.diagnostics(index)).toMatchObject({
      lookupCandidates: 3,
      lookupReaddirCalls: 0,
      lookupStatCalls: 1,
    });
  });

  it("notices same-timestamp additions and deletions after warm", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");

    const index = await __test__.createIndex(repo);
    await __test__.waitForWarm(index);
    const before = await stat(join(repo, "runs"));

    await writeFile(join(repo, "runs/second.json"), "{}\n");
    await utimes(join(repo, "runs"), before.atime, before.mtime);

    expect(await index.has("runs/second.json")).toBe(true);

    const afterAdd = await stat(join(repo, "runs"));
    await rm(join(repo, "runs/second.json"));
    await utimes(join(repo, "runs"), afterAdd.atime, afterAdd.mtime);

    expect(await index.has("runs/second.json")).toBe(false);
  });

  it("rejects absolute and parent-traversal paths before filesystem I/O", async () => {
    const repo = await createRepo();
    const index = await __test__.createIndex(repo, { startWarm: false });

    expect(
      await index.findExisting([
        "/etc/passwd",
        "../outside.txt",
        "runs/../../outside.txt",
      ]),
    ).toEqual(new Set());
    expect(__test__.diagnostics(index)).toMatchObject({
      lookupReaddirCalls: 0,
      lookupStatCalls: 0,
    });
  });

  it("keeps cache growth within its node bound", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "wide"));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(join(repo, "wide", `${index}.txt`), "x"),
      ),
    );
    const index = await __test__.createIndex(repo, {
      maxCachedNodes: 4,
      startWarm: false,
    });

    expect(await index.has("wide/7.txt")).toBe(true);
    const diagnostics = __test__.diagnostics(index);
    expect(diagnostics.cacheLimitHit).toBe(true);
    expect(diagnostics.cachedNodes).toBeLessThanOrEqual(4);
  });

  it("keeps crawl exclusions separate from on-demand visibility", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "node_modules/pkg"), { recursive: true });
    await mkdir(join(repo, "blocked/deep"), { recursive: true });
    await writeFile(join(repo, "node_modules/pkg/index.js"), "export {};\n");
    await writeFile(join(repo, "blocked/deep/result.json"), "{}\n");
    await writeFile(join(repo, ".yepignore"), "blocked\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await Promise.all(
      ["node_modules", "node_modules/pkg", "blocked", "blocked/deep"].map(
        (directory) => utimes(join(repo, directory), old, old),
      ),
    );

    const index = await __test__.createIndex(repo);
    await __test__.waitForWarm(index);
    __test__.resetDiagnostics(index);

    // A present .yepignore replaces the default, so node_modules is warm.
    expect(await index.has("node_modules/pkg/index.js")).toBe(true);
    expect(__test__.diagnostics(index).lookupReaddirCalls).toBe(0);

    __test__.resetDiagnostics(index);
    // The configured block affects only warming; lookup remains authoritative.
    expect(await index.has("blocked/deep/result.json")).toBe(true);
    expect(__test__.diagnostics(index).lookupReaddirCalls).toBeGreaterThan(0);

    __test__.resetDiagnostics(index);
    // .git remains excluded even when a custom file replaces the defaults.
    expect(await index.has(".git/config")).toBe(true);
    expect(__test__.diagnostics(index).lookupReaddirCalls).toBeGreaterThan(0);
  });

  it("skips node_modules during the default warm", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "node_modules/pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules/pkg/index.js"), "export {};\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await Promise.all(
      ["node_modules", "node_modules/pkg"].map((directory) =>
        utimes(join(repo, directory), old, old),
      ),
    );

    const index = await __test__.createIndex(repo);
    await __test__.waitForWarm(index);
    __test__.resetDiagnostics(index);

    expect(await index.has("node_modules/pkg/index.js")).toBe(true);
    expect(__test__.diagnostics(index).lookupReaddirCalls).toBeGreaterThan(0);
  });

  it("logs malformed .yepignore once and falls back to defaults", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, ".yepignore"), "../outside\n");
    await mkdir(join(repo, "node_modules/pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules/pkg/index.js"), "export {};\n");
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);

    const index = await __test__.createIndex(repo);
    await __test__.waitForWarm(index);
    await __test__.createIndex(repo, { startWarm: false });

    expect(warn).toHaveBeenCalledTimes(1);
    __test__.resetDiagnostics(index);
    expect(await index.has("node_modules/pkg/index.js")).toBe(true);
    expect(__test__.diagnostics(index).lookupReaddirCalls).toBeGreaterThan(0);
  });
});

describe("linkifyProjectPaths", () => {
  const index = {
    has: (path: string) =>
      path === "untracked/pii-eval/prod/nl-final20-control.jsonl" ||
      path === "scripts/run.py",
    findExisting: async (paths: readonly string[]) =>
      new Set(paths.filter((path) => index.has(path))),
    size: 2,
    truncated: false,
  };

  it("links a path that is a project file and leaves the rest alone", async () => {
    const html =
      '<span class="line">  &quot;path&quot;: ' +
      "&quot;untracked/pii-eval/prod/nl-final20-control.jsonl&quot;,</span>";

    const out = await linkifyProjectPaths(html, { projectPath: "/repo", index });

    expect(out).toContain('data-ya-resource="local-file"');
    expect(out).toContain(
      "/repo/untracked/pii-eval/prod/nl-final20-control.jsonl",
    );
    // The JSON punctuation around the value is not swallowed into the link.
    expect(out).toContain("&quot;,</span>");
  });

  it("does not link a string that merely looks like a path", async () => {
    const html =
      '<span class="line">"media": "application/json", "v": "1.2.3", ' +
      '"missing": "runs/absent.jsonl"</span>';

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index }),
    ).toBe(html);
  });

  it("never rewrites markup, only text between tags", async () => {
    // A tag attribute happens to contain a real project path.
    const html = '<span class="scripts/run.py">plain</span>';

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index }),
    ).toBe(html);
  });

  it("does not link the file being viewed to itself", async () => {
    const html = '<span class="line">scripts/run.py</span>';

    expect(
      await linkifyProjectPaths(html, {
        projectPath: "/repo",
        index,
        selfRelativePath: "scripts/run.py",
      }),
    ).toBe(html);
  });

  it("returns content unchanged when nothing is indexed", async () => {
    const html = '<span class="line">scripts/run.py</span>';
    const empty = {
      has: () => false,
      findExisting: async () => new Set<string>(),
      size: 0,
      truncated: false,
    };

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index: empty }),
    ).toBe(html);
  });

  it("does lookup I/O per referenced directory, not per token", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"));
    await writeFile(join(repo, "runs/exists.json"), "{}\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(join(repo, "runs"), old, old);
    const realIndex = await __test__.createIndex(repo, { startWarm: false });
    expect(await realIndex.has("runs/exists.json")).toBe(true);
    __test__.resetDiagnostics(realIndex);

    const tokens = Array.from({ length: 4_000 }, (_, tokenIndex) =>
      tokenIndex % 20 === 0
        ? "runs/exists.json"
        : `runs/missing-${tokenIndex % 200}.json`,
    );
    const out = await linkifyProjectPaths(
      `<span>${tokens.join(" ")}</span>`,
      { projectPath: repo, index: realIndex },
    );

    expect(out).toContain('data-ya-resource="local-file"');
    expect(__test__.diagnostics(realIndex)).toMatchObject({
      lookupCandidates: 191,
      lookupReaddirCalls: 0,
      lookupStatCalls: 1,
    });
  });
});
