import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseAuthorColorSeed,
  getGitAuthorIdentity,
  getGitAuthorPalette,
  resetGitAuthorPaletteForTests,
} from "./authorPalette.js";
import { getBlame, resetBlameCacheForTest } from "./blame.js";

const execFileAsync = promisify(execFile);
const repos: string[] = [];

describe("Git author palette", () => {
  afterEach(async () => {
    resetGitAuthorPaletteForTests();
    resetBlameCacheForTest();
    await Promise.all(
      repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
    );
  });

  it("maximizes each new remembered hue's minimum distance", () => {
    const first = chooseAuthorColorSeed("A", []);
    const second = chooseAuthorColorSeed("B", [first]);
    const third = chooseAuthorColorSeed("C", [first, second]);

    expect(circularDistance(first, second)).toBe(180);
    expect(
      Math.min(circularDistance(third, first), circularDistance(third, second)),
    ).toBe(90);
  });

  it("reuses the stable preference once every hue is occupied", () => {
    const occupied = Array.from({ length: 360 }, (_, seed) => seed);
    expect(chooseAuthorColorSeed("new author", occupied)).toBe(
      chooseAuthorColorSeed("new author", []),
    );
  });

  it("persists colors and incrementally learns authors on new commits", async () => {
    const repo = await makeRepo("ya-author-palette-");
    await git(repo, ["init"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["config", "user.name", "First"]);
    await git(repo, ["config", "user.email", "first@example.com"]);
    await writeFile(join(repo, "file.txt"), "one\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "first"]);

    const first = await getGitAuthorPalette(repo);
    const firstKey = getGitAuthorIdentity("First", "first@example.com");
    expect(first?.seeds.has(firstKey)).toBe(true);

    await git(repo, ["config", "user.name", "Second"]);
    await git(repo, ["config", "user.email", "second@example.com"]);
    await writeFile(join(repo, "file.txt"), "one\ntwo\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "second"]);

    const second = await getGitAuthorPalette(repo);
    expect(second?.seeds.get(firstKey)).toBe(first?.seeds.get(firstKey));
    expect(
      second?.seeds.has(getGitAuthorIdentity("Second", "second@example.com")),
    ).toBe(true);
  });

  it("rebuilds once from corrupt persisted state", async () => {
    const repo = await makeRepo("ya-author-palette-corrupt-");
    await git(repo, ["init"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["config", "user.name", "First"]);
    await git(repo, ["config", "user.email", "first@example.com"]);
    await writeFile(join(repo, "file.txt"), "one\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "first"]);
    await getGitAuthorPalette(repo);
    resetGitAuthorPaletteForTests();

    const palettePath = join(repo, ".yep", "git-author-palette.json");
    await writeFile(palettePath, "{broken");
    const rebuilt = await getGitAuthorPalette(repo);
    expect(rebuilt?.seeds.size).toBe(1);
    expect(JSON.parse(await readFile(palettePath, "utf8")).version).toBe(1);
  });

  it("fails safely after the single regeneration attempt", async () => {
    const notARepository = await makeRepo("ya-author-palette-not-git-");
    await expect(getGitAuthorPalette(notARepository)).resolves.toBeNull();
  });

  it("attaches the remembered author seed to blame lines", async () => {
    const repo = await makeRepo("ya-author-palette-blame-");
    await git(repo, ["init"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    await git(repo, ["config", "user.name", "Blame Author"]);
    await git(repo, ["config", "user.email", "blame@example.com"]);
    await writeFile(join(repo, "file.txt"), "line\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "-m", "add blamed line"]);

    const palette = await getGitAuthorPalette(repo);
    const result = await getBlame(repo, "file.txt", undefined);
    expect(result.lines[0]?.authorColorSeed).toBe(
      palette?.seeds.get(
        getGitAuthorIdentity("Blame Author", "blame@example.com"),
      ),
    );
  });
});

async function makeRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  repos.push(repo);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-28T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-28T00:00:00Z",
    },
  });
}

function circularDistance(left: number, right: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, 360 - distance);
}
