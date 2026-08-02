import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { linkifyProjectPaths } from "../../src/augments/project-path-links.js";
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
  __test__.reset();
  await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("project path index", () => {
  it("indexes untracked files, not only tracked ones", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "tracked.md"), "# tracked\n");
    await execFileAsync("git", ["-C", repo, "add", "tracked.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "add"]);
    await mkdir(join(repo, "untracked/runs"), { recursive: true });
    await writeFile(join(repo, "untracked/runs/eval-v2.jsonl"), "{}\n");

    const index = await getProjectPathIndex(repo);

    expect(index.has("tracked.md")).toBe(true);
    // The reported case: an agent hands over a path under an untracked
    // results directory, which `git ls-files` would never report.
    expect(index.has("untracked/runs/eval-v2.jsonl")).toBe(true);
    expect(index.has("does/not/exist.json")).toBe(false);
  });

  it("advances its recheck floor so a quiet project is not re-swept per view", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");

    await getProjectPathIndex(repo, 1_000);
    // Well past the floor, but nothing changed: the check must record that it
    // looked, so the next view inside the window costs nothing.
    const later = 1_000 + __test__.RECHECK_INTERVAL_MS + 1;
    await getProjectPathIndex(repo, later);

    await writeFile(join(repo, "runs/second.json"), "{}\n");
    const withinWindow = await getProjectPathIndex(repo, later + 1);
    expect(withinWindow.has("runs/second.json")).toBe(false);

    const afterWindow = await getProjectPathIndex(
      repo,
      later + __test__.RECHECK_INTERVAL_MS + 1,
    );
    expect(afterWindow.has("runs/second.json")).toBe(true);
  });

  it("notices a file added after the index was built", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "runs"), { recursive: true });
    await writeFile(join(repo, "runs/first.json"), "{}\n");

    const first = await getProjectPathIndex(repo, 1_000);
    expect(first.has("runs/second.json")).toBe(false);

    await writeFile(join(repo, "runs/second.json"), "{}\n");

    // Past the recheck floor, the directory's changed mtime forces a rebuild.
    const second = await getProjectPathIndex(
      repo,
      1_000 + __test__.RECHECK_INTERVAL_MS + 1,
    );
    expect(second.has("runs/second.json")).toBe(true);
  });
});

describe("linkifyProjectPaths", () => {
  const index = {
    has: (path: string) =>
      path === "untracked/pii-eval/prod/nl-final20-control.jsonl" ||
      path === "scripts/run.py",
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
    const empty = { has: () => false, size: 0, truncated: false };

    expect(
      await linkifyProjectPaths(html, { projectPath: "/repo", index: empty }),
    ).toBe(html);
  });
});
