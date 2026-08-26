import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSshTarget } from "../../../src/sdk/providers/managed-ssh-target.js";
import {
  type ManagedSshWorkspace,
  ManagedSshWorkspaceService,
} from "../../../src/sdk/providers/managed-ssh-workspace.js";

const fakeSshPath = fileURLToPath(
  new URL("./fixtures/fake-managed-ssh.mjs", import.meta.url),
);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createSourceRepository(options: {
  dirty: boolean;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "managed-workspace-source-"));
  temporaryPaths.push(directory);
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  git(directory, ["config", "user.email", "gate-b@example.invalid"]);
  git(directory, ["config", "user.name", "Gate B Fixture"]);
  await writeFile(join(directory, "tracked.txt"), "base\n");
  await writeFile(join(directory, "staged.txt"), "base\n");
  git(directory, ["add", "tracked.txt", "staged.txt"]);
  git(directory, ["commit", "--quiet", "-m", "base"]);
  if (options.dirty) {
    await writeFile(join(directory, "tracked.txt"), "local unstaged\n");
    await writeFile(join(directory, "staged.txt"), "local staged\n");
    git(directory, ["add", "staged.txt"]);
    await writeFile(join(directory, "untracked.txt"), "local untracked\n");
  }
  return directory;
}

async function createService(): Promise<{
  root: string;
  recordPath: string;
  service: ManagedSshWorkspaceService;
}> {
  const fixture = await mkdtemp(join(tmpdir(), "managed-workspace-target-"));
  temporaryPaths.push(fixture);
  const root = join(fixture, "managed-root");
  const recordPath = join(fixture, "ssh-record.jsonl");
  const target = new ManagedSshTarget({
    hostAlias: "fixture-linux",
    remoteRoot: root,
    sshCommand: fakeSshPath,
    nodeCommand: process.execPath,
    spawnEnvironment: { ...process.env, YA_FAKE_SSH_RECORD: recordPath },
  });
  const inspection = await target.inspect();
  return {
    root,
    recordPath,
    service: new ManagedSshWorkspaceService(target, inspection),
  };
}

function sourceFingerprint(source: string): Record<string, string> {
  return {
    head: git(source, ["rev-parse", "HEAD"]),
    branch: git(source, ["symbolic-ref", "HEAD"]),
    status: git(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
    diff: git(source, ["diff", "--binary"]),
    cachedDiff: git(source, ["diff", "--cached", "--binary"]),
    trackedBytes: readFileSync(join(source, "tracked.txt"), "hex"),
    stagedBytes: readFileSync(join(source, "staged.txt"), "hex"),
    untrackedBytes: readFileSync(join(source, "untracked.txt"), "hex"),
  };
}

async function configureTargetAuthor(
  service: ManagedSshWorkspaceService,
  workspace: ManagedSshWorkspace,
): Promise<void> {
  await service.runFixtureCommand(
    workspace,
    "git config user.email gate-b-target@example.invalid; git config user.name 'Gate B Target'",
  );
}

describe.skipIf(process.platform === "win32")(
  "ManagedSshWorkspaceService",
  () => {
    it("round-trips exact committed work through amend without touching the source checkout", async () => {
      const source = await createSourceRepository({ dirty: true });
      const before = sourceFingerprint(source);
      const { recordPath, service } = await createService();

      const workspace = await service.prepare(source);

      expect(workspace.source).toEqual({
        baseCommit: before.head,
        branch: "refs/heads/main",
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
      });
      expect(await service.observe(workspace)).toMatchObject({
        head: before.head,
        branchRef: workspace.branchRef,
        worktreePath: workspace.remoteWorktreePath,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
      });
      expect(
        await readFile(
          join(workspace.remoteWorktreePath, "tracked.txt"),
          "utf8",
        ),
      ).toBe("base\n");
      await expect(
        stat(join(workspace.remoteWorktreePath, "untracked.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await configureTargetAuthor(service, workspace);
      await service.runFixtureCommand(
        workspace,
        "printf 'one\\n' > change.txt; git add change.txt; git commit --quiet -m one",
      );
      await service.runFixtureCommand(
        workspace,
        "printf 'two\\n' >> change.txt; git add change.txt; git commit --quiet -m two",
      );
      const beforeAmend = (await service.observe(workspace)).head;
      await service.runFixtureCommand(
        workspace,
        "printf 'amended\\n' >> change.txt; git add change.txt; git commit --quiet --amend -m amended",
      );
      const amended = await service.observe(workspace);
      expect(amended.head).not.toBe(beforeAmend);

      const destination =
        await ManagedSshWorkspaceService.createDisposableFetchRepository();
      temporaryPaths.push(destination);
      const fetched = await service.fetchIntoDisposableRepository(
        workspace,
        destination,
      );

      expect(fetched).toMatchObject({
        announcedHead: amended.head,
        fetchedHead: amended.head,
        baseIsAncestor: true,
        targetAdvancedDuringFetch: false,
      });
      expect(git(destination, ["rev-parse", fetched.destinationRef])).toBe(
        amended.head,
      );
      expect(sourceFingerprint(source)).toEqual(before);
      expect(await service.cleanup(workspace)).toEqual({
        disposition: "deleted",
        explicitDiscard: false,
      });
      await expect(stat(workspace.remoteDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const records = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.length).toBeGreaterThan(5);
      for (const record of records) {
        expect(record.args).toContain("-T");
        expect(record.args).not.toContain("-t");
        expect(record.args).toContain("BatchMode=yes");
        expect(record.args.join(" ")).not.toContain("StrictHostKeyChecking");
      }
    });

    it("retains dirty and unfetched state and only explicitly discards it", async () => {
      const source = await createSourceRepository({ dirty: false });
      const { service } = await createService();
      const dirty = await service.prepare(source);
      await service.runFixtureCommand(dirty, "printf dirty > untracked.txt");

      expect(await service.cleanup(dirty)).toMatchObject({
        disposition: "retained",
        reason: "dirty",
        observation: { untrackedCount: 1 },
      });
      expect(await service.cleanup(dirty, { explicitDiscard: true })).toEqual({
        disposition: "deleted",
        explicitDiscard: true,
      });

      const committed = await service.prepare(source);
      await configureTargetAuthor(service, committed);
      await service.runFixtureCommand(
        committed,
        "printf committed > result.txt; git add result.txt; git commit --quiet -m result",
      );
      expect(await service.cleanup(committed)).toMatchObject({
        disposition: "retained",
        reason: "committed-but-unfetched",
      });
      const destination =
        await ManagedSshWorkspaceService.createDisposableFetchRepository();
      temporaryPaths.push(destination);
      await service.fetchIntoDisposableRepository(committed, destination);
      expect(await service.cleanup(committed)).toEqual({
        disposition: "deleted",
        explicitDiscard: false,
      });
    });

    it("refuses an ordinary repository as a fetch destination", async () => {
      const source = await createSourceRepository({ dirty: false });
      const { service } = await createService();
      const workspace = await service.prepare(source);

      await expect(
        service.fetchIntoDisposableRepository(workspace, source),
      ).rejects.toThrow("marked disposable bare repository");
      expect(
        await service.cleanup(workspace, { explicitDiscard: true }),
      ).toEqual({
        disposition: "deleted",
        explicitDiscard: true,
      });
    });
  },
);
