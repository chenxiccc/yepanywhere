import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import type { Dirent, FSWatcher } from "node:fs";
import {
  mkdtemp,
  mkdir,
  lstat,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkifyProjectPaths } from "../../src/augments/project-path-links.js";
import {
  __test__,
  getProjectPathIndex,
  projectPathCacheDiagnostics,
  type PathIndexIo,
  type ProjectPathIndex,
} from "../../src/projects/projectPathIndex.js";

const execFileAsync = promisify(execFile);
const repos: string[] = [];

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ya-path-index-"));
  repos.push(dir);
  return dir;
}

async function createGitRepo(): Promise<string> {
  const dir = await createRepo();
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@example"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

interface RecordedIo extends PathIndexIo {
  readonly listed: string[];
  readonly probed: string[];
  readonly watched: string[];
  failWatch(path: string): void;
  emitError(path: string): void;
  emitEvent(path: string, filename: string): void;
}

/**
 * Filesystem adapter that records which paths each lookup touches, so a test
 * can assert the absence of I/O under an unrelated subtree rather than only
 * counting calls.
 */
function recordingIo(root: string): RecordedIo {
  const listed: string[] = [];
  const probed: string[] = [];
  const watched: string[] = [];
  const watchers = new Map<string, EventEmitter[]>();
  const unwatchable = new Set<string>();
  const relativeToRoot = (path: string) => relative(root, path) || ".";

  return {
    listed,
    probed,
    watched,
    failWatch(path) {
      unwatchable.add(path);
    },
    emitError(path) {
      for (const watcher of watchers.get(path) ?? []) {
        watcher.emit("error", new Error("watch overflow"));
      }
    },
    emitEvent(path, filename) {
      for (const watcher of watchers.get(path) ?? []) {
        watcher.emit("test:change", filename);
      }
    },
    lstat(path) {
      probed.push(relativeToRoot(path));
      return lstat(path);
    },
    readdir(path): Promise<Dirent[]> {
      listed.push(relativeToRoot(path));
      return readdir(path, { withFileTypes: true });
    },
    watch(path, listener) {
      const key = relativeToRoot(path);
      if (unwatchable.has(key)) throw new Error("watch unavailable");
      watched.push(key);
      const emitter = new EventEmitter();
      emitter.on("test:change", (filename: string) =>
        listener("rename", filename),
      );
      const existing = watchers.get(key) ?? [];
      existing.push(emitter);
      watchers.set(key, existing);
      return Object.assign(emitter, {
        close: () => {
          watchers.set(
            key,
            (watchers.get(key) ?? []).filter((entry) => entry !== emitter),
          );
        },
      }) as unknown as FSWatcher;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  __test__.reset();
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("project path index", () => {
  it("finds files inside gitignored directories", async () => {
    const repo = await createGitRepo();
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
      await linkifyProjectPaths("<span>untracked/runs/eval-v2.jsonl</span>", {
        projectPath: repo,
        index,
      }),
    ).toContain('data-ya-resource="local-file"');
    index.release();
  });

  it("creates an index without reading the project", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    const io = recordingIo(repo);

    __test__.createIndex(repo, { io });
    await new Promise((done) => setTimeout(done, 20));

    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);
    expect(io.watched).toEqual([]);
  });

  it("reads only the component chain a candidate uses", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "src/deep/nested"), { recursive: true });
    await writeFile(join(repo, "src/deep/nested/server.ts"), "export {};\n");
    // An unrelated subtree the size of a run-artifact directory.
    await mkdir(join(repo, "runs/eval"), { recursive: true });
    await Promise.all(
      Array.from({ length: 40 }, (_, entry) =>
        writeFile(join(repo, "runs/eval", `${entry}.jsonl`), "{}\n"),
      ),
    );
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("src/deep/nested/server.ts")).toBe(true);

    expect(io.probed).toEqual([
      "src",
      join("src", "deep"),
      join("src", "deep", "nested"),
      join("src", "deep", "nested", "server.ts"),
    ]);
    expect(io.listed).toEqual([]);
    expect(io.watched.some((path) => path.startsWith("runs"))).toBe(false);
    index.dispose();
  });

  it("lists one directory for a wide batch, then answers it with no I/O", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    const found = await index.findExisting([
      "runs/first.json",
      "runs/missing-a.json",
      "runs/missing-b.json",
      "runs/missing-c.json",
    ]);

    expect(found).toEqual(new Set(["runs/first.json"]));
    expect(io.listed).toEqual(["runs"]);
    // Only the `runs` component itself was probed; its children came from the
    // one listing.
    expect(io.probed).toEqual(["runs"]);

    __test__.resetDiagnostics(index);
    io.listed.length = 0;
    io.probed.length = 0;

    expect(
      await index.findExisting([
        "runs/first.json",
        "runs/missing-a.json",
        "runs/missing-z.json",
      ]),
    ).toEqual(new Set(["runs/first.json"]));
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);
    expect(__test__.diagnostics(index)).toMatchObject({
      cachedAnswers: 4,
      completeDirectories: 1,
      directoryListings: 0,
      exactProbes: 0,
    });
    index.dispose();
  });

  it("probes a sparse candidate set instead of listing its directory", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.findExisting(["runs/first.json"])).toEqual(
      new Set(["runs/first.json"]),
    );

    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual(["runs", join("runs", "first.json")]);
    // A proven exact answer is cached without claiming the directory is
    // completely known.
    expect(__test__.diagnostics(index).completeDirectories).toBe(0);
    io.probed.length = 0;
    expect(await index.has("runs/first.json")).toBe(true);
    expect(io.probed).toEqual([]);
    index.dispose();
  });

  it("coalesces concurrent probes of the same candidate", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    const [first, second] = await Promise.all([
      index.has("one.json"),
      index.has("one.json"),
    ]);

    expect([first, second]).toEqual([true, true]);
    expect(io.probed).toEqual(["one.json"]);
    index.dispose();
  });

  it("rejects absolute and parent-traversal paths before filesystem I/O", async () => {
    const repo = await createRepo();
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(
      await index.findExisting([
        "/etc/passwd",
        "../outside.txt",
        "runs/../../outside.txt",
      ]),
    ).toEqual(new Set());
    expect(io.probed).toEqual([]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("invalidates a cached answer when the watched directory changes", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/late.json")).toBe(false);
    expect(io.watched).toContain("runs");

    await writeFile(join(repo, "runs/late.json"), "{}\n");
    io.emitEvent("runs", "late.json");

    expect(await index.has("runs/late.json")).toBe(true);
    expect(__test__.diagnostics(index).watcherInvalidations).toBe(1);

    await rm(join(repo, "runs/late.json"));
    io.emitEvent("runs", "late.json");

    expect(await index.has("runs/late.json")).toBe(false);
    index.dispose();
  });

  it("invalidates a complete listing entry by entry", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/kept.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    await index.findExisting([
      "runs/kept.json",
      "runs/a.json",
      "runs/b.json",
      "runs/c.json",
    ]);
    expect(io.listed).toEqual(["runs"]);
    io.probed.length = 0;
    io.listed.length = 0;

    await writeFile(join(repo, "runs/a.json"), "{}\n");
    io.emitEvent("runs", "a.json");

    expect(
      await index.findExisting([
        "runs/kept.json",
        "runs/a.json",
        "runs/b.json",
      ]),
    ).toEqual(new Set(["runs/kept.json", "runs/a.json"]));
    // Only the named entry lost its cached answer.
    expect(io.probed).toEqual([join("runs", "a.json")]);
    expect(io.listed).toEqual([]);
    index.dispose();
  });

  it("discards a generation the watcher can no longer vouch for", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/kept.json"), "{}\n");
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/missing.json")).toBe(false);
    io.probed.length = 0;

    // A watch error can hide any number of changes, so nothing it covered may
    // stay trusted.
    await writeFile(join(repo, "runs/missing.json"), "{}\n");
    io.emitError("runs");

    expect(__test__.diagnostics(index).uncertainGenerations).toBe(1);
    expect(await index.has("runs/missing.json")).toBe(true);

    // The scheduled reconciliation re-establishes the directory on its own.
    await vi.waitFor(() => expect(io.listed).toContain("runs"));
    index.dispose();
  });

  it("answers correctly when a directory cannot be watched", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");
    const io = recordingIo(repo);
    io.failWatch("runs");
    const index = __test__.createIndex(repo, { io });

    expect(await index.has("runs/first.json")).toBe(true);
    io.probed.length = 0;

    // Nothing keeps an unwatched directory's answers true, so they are re-read
    // rather than trusted.
    expect(await index.has("runs/first.json")).toBe(true);
    expect(io.probed).toEqual([join("runs", "first.json")]);
    index.dispose();
  });

  it("keeps the queried names from an oversized listing without claiming it", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "wide"), { recursive: true });
    await Promise.all(
      Array.from({ length: 8 }, (_, entry) =>
        writeFile(join(repo, "wide", `${entry}.txt`), "x"),
      ),
    );
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io, maxRetainedEntries: 4 });

    const names = Array.from({ length: 8 }, (_, entry) => `wide/${entry}.txt`);
    expect((await index.findExisting(names)).size).toBe(8);

    const diagnostics = __test__.diagnostics(index);
    expect(diagnostics.oversizedListings).toBe(1);
    // Too wide to answer arbitrary absence, but the eight names it did prove
    // are worth exactly what the batch asked for.
    expect(diagnostics.completeDirectories).toBe(0);
    io.listed.length = 0;
    io.probed.length = 0;

    expect((await index.findExisting(names)).size).toBe(8);
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([]);

    // A name outside that batch was never proven, so it costs one probe rather
    // than a second full read of the directory.
    expect(await index.has("wide/unqueried.txt")).toBe(false);
    expect(io.listed).toEqual([]);
    expect(io.probed).toEqual([join("wide", "unqueried.txt")]);
    index.dispose();
  });

  it("drops least-recently-used subtrees over the project byte ceiling", async () => {
    const repo = await createRepo();
    for (const directory of ["one", "two", "three"]) {
      await mkdir(join(repo, directory), { recursive: true });
      await Promise.all(
        Array.from({ length: 6 }, (_, entry) =>
          writeFile(join(repo, directory, `${entry}.txt`), "x"),
        ),
      );
    }
    const io = recordingIo(repo);
    const index = __test__.createIndex(repo, { io, maxIndexBytes: 900 });

    for (const directory of ["one", "two", "three"]) {
      await index.findExisting(
        Array.from({ length: 6 }, (_, entry) => `${directory}/${entry}.txt`),
      );
    }

    const diagnostics = __test__.diagnostics(index);
    expect(diagnostics.evictedDirectories).toBeGreaterThan(0);
    expect(diagnostics.retainedBytes).toBeLessThanOrEqual(900);
    // Evicted state is rebuildable, so the answer is unchanged.
    expect(await index.has("one/0.txt")).toBe(true);
    index.dispose();
  });
});

describe("project path cache ownership", () => {
  it("shares one cache per project and releases each claim", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");

    const first = await getProjectPathIndex(repo);
    const second = await getProjectPathIndex(repo);
    expect(__test__.registryEntry(repo)?.refs).toBe(2);

    expect(await first.has("one.json")).toBe(true);
    expect(await second.has("one.json")).toBe(true);
    expect(projectPathCacheDiagnostics().projects).toBe(1);

    first.release();
    first.release();
    expect(__test__.registryEntry(repo)?.refs).toBe(1);
    second.release();
    expect(__test__.registryEntry(repo)?.refs).toBe(0);
  });

  it("evicts unclaimed projects under process pressure and rebuilds on demand", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "one.json"), "{}\n");
    const claimed = await createRepo();
    await writeFile(join(claimed, "two.json"), "{}\n");

    const cold = await getProjectPathIndex(repo);
    expect(await cold.has("one.json")).toBe(true);
    cold.release();
    const held = await getProjectPathIndex(claimed);
    expect(await held.has("two.json")).toBe(true);

    // Force the pressure decision rather than retaining 32 MiB of names.
    __test__.enforceProcessBudget(0);

    expect(projectPathCacheDiagnostics().projects).toBe(1);
    expect(__test__.registryEntry(repo)).toBeUndefined();
    // A claimed project is never evicted out from under its holder.
    expect(__test__.registryEntry(claimed)).toBeDefined();

    // The discarded project still answers; it simply rebuilds what it needs.
    const rebuilt = await getProjectPathIndex(repo);
    expect(await rebuilt.has("one.json")).toBe(true);
    rebuilt.release();
    held.release();
  });
});

describe("linkifyProjectPaths", () => {
  const index: ProjectPathIndex = {
    findExisting: async (paths: readonly string[]) =>
      new Set(paths.filter((path) => existsInFake(path))),
    has: async (path: string) => existsInFake(path),
    release: () => undefined,
  };

  function existsInFake(path: string): boolean {
    return (
      path === "untracked/pii-eval/prod/nl-final20-control.jsonl" ||
      path === "scripts/run.py"
    );
  }

  it("links a path that is a project file and leaves the rest alone", async () => {
    const html =
      '<span class="line">  &quot;path&quot;: ' +
      "&quot;untracked/pii-eval/prod/nl-final20-control.jsonl&quot;,</span>";

    const out = await linkifyProjectPaths(html, {
      projectPath: "/repo",
      index,
    });

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
    const empty: ProjectPathIndex = {
      findExisting: async () => new Set<string>(),
      has: async () => false,
      release: () => undefined,
    };

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index: empty }),
    ).toBe(html);
  });

  it("does lookup I/O per referenced directory, not per token", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"));
    await writeFile(join(repo, "runs/exists.json"), "{}\n");
    const io = recordingIo(repo);
    const realIndex = __test__.createIndex(repo, { io });

    const tokens = Array.from({ length: 4_000 }, (_, tokenIndex) =>
      tokenIndex % 20 === 0
        ? "runs/exists.json"
        : `runs/missing-${tokenIndex % 200}.json`,
    );
    const out = await linkifyProjectPaths(`<span>${tokens.join(" ")}</span>`, {
      projectPath: repo,
      index: realIndex,
    });

    expect(out).toContain('data-ya-resource="local-file"');
    // 191 distinct candidates in one directory: one probe for the directory
    // component and one listing that answers every name in it.
    expect(__test__.diagnostics(realIndex)).toMatchObject({
      directoryListings: 1,
      exactProbes: 1,
      lookupCandidates: 191,
    });
    realIndex.dispose();
  });
});
