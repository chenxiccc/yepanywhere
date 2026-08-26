import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { quoteShellWord } from "../../utils/posixShell.js";
import {
  assertContainedRemotePath,
  type ManagedSshInspection,
  type ManagedSshTarget,
} from "./managed-ssh-target.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ManagedSourceDisclosure {
  baseCommit: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  branch: string | null;
}

export interface ManagedSshWorkspace {
  workspaceId: string;
  repositoryIdentity: string;
  baseCommit: string;
  branchRef: string;
  remoteDirectory: string;
  remoteAnchorPath: string;
  remoteWorktreePath: string;
  source: ManagedSourceDisclosure;
}

export interface ManagedWorkspaceObservation {
  head: string;
  branchRef: string;
  worktreePath: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

export interface ManagedWorkspaceFetchResult {
  announcedHead: string;
  fetchedHead: string;
  destinationRef: string;
  baseIsAncestor: boolean;
  targetAdvancedDuringFetch: boolean;
}

export type ManagedWorkspaceCleanupResult =
  | { disposition: "deleted"; explicitDiscard: boolean }
  | {
      disposition: "retained";
      reason: "dirty" | "committed-but-unfetched" | "target-advanced";
      observation: ManagedWorkspaceObservation;
    };

interface WorkspaceRecord {
  workspace: ManagedSshWorkspace;
  lastFetchedHead?: string;
  targetAdvancedDuringFetch: boolean;
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class ManagedSshWorkspaceService {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(
    private readonly target: ManagedSshTarget,
    inspection: ManagedSshInspection,
  ) {
    if (inspection.platform !== "Linux") {
      throw new Error(
        "Managed SSH workspaces currently require a Linux target",
      );
    }
    if (!inspection.git.available) {
      throw new Error("Managed SSH workspaces require target Git");
    }
    if (
      inspection.managedRootState !== "creatable" &&
      inspection.managedRootState !== "private-writable"
    ) {
      throw new Error("Managed SSH workspace root is not private and writable");
    }
  }

  async prepare(
    sourceRepositoryPath: string,
    options: { workspaceId?: string } = {},
  ): Promise<ManagedSshWorkspace> {
    if (process.platform === "win32") {
      throw new Error(
        "Managed SSH workspaces do not yet support Windows controllers",
      );
    }
    if (!isAbsolute(sourceRepositoryPath)) {
      throw new Error("Managed workspace source repository must be absolute");
    }
    const sourcePath = resolve(sourceRepositoryPath);
    const topLevel = (
      await runGit(sourcePath, ["rev-parse", "--show-toplevel"])
    ).stdout
      .toString("utf8")
      .trim();
    if (resolve(topLevel) !== sourcePath) {
      throw new Error("Managed workspace source must name the repository root");
    }
    const source = await inspectSource(sourcePath);
    const workspaceId = options.workspaceId ?? randomUUID();
    assertWorkspaceId(workspaceId);
    if (this.records.has(workspaceId)) {
      throw new Error("Managed workspace ID is already owned by this service");
    }

    const repositoryIdentity = randomUUID();
    const remoteDirectory = `${this.target.remoteRoot}/workspaces/${workspaceId}`;
    const remoteAnchorPath = `${remoteDirectory}/anchor.git`;
    const remoteWorktreePath = `${remoteDirectory}/worktree`;
    const branchRef = `refs/heads/ya-managed/${workspaceId}`;
    for (const path of [
      remoteDirectory,
      remoteAnchorPath,
      remoteWorktreePath,
    ]) {
      assertContainedRemotePath(
        this.target.remoteRoot,
        path,
        "managed workspace path",
      );
    }
    const workspace: ManagedSshWorkspace = {
      workspaceId,
      repositoryIdentity,
      baseCommit: source.baseCommit,
      branchRef,
      remoteDirectory,
      remoteAnchorPath,
      remoteWorktreePath,
      source,
    };

    try {
      await this.createRemoteAnchor(workspace);
      await runGit(
        sourcePath,
        [
          "push",
          "--no-verify",
          "--porcelain",
          this.target.gitRemoteUrl(remoteAnchorPath),
          `${source.baseCommit}:${branchRef}`,
        ],
        this.gitEnvironment(),
      );
      await this.createAndVerifyRemoteWorktree(workspace);
    } catch (error) {
      await this.discardPreparedWorkspace(workspace).catch(() => {});
      throw error;
    }
    this.records.set(workspaceId, {
      workspace,
      targetAdvancedDuringFetch: false,
    });
    return workspace;
  }

  async observe(
    workspace: ManagedSshWorkspace,
  ): Promise<ManagedWorkspaceObservation> {
    this.requireOwnedWorkspace(workspace);
    const command = workspaceObservationCommand(workspace);
    const result = await this.target.runCommand(command);
    const values = parseKeyValueOutput(result.stdout);
    const head = requireCommit(values.head, "target workspace HEAD");
    const branchRef = requiredValue(values, "branch");
    const worktreePath = requiredValue(values, "worktree");
    if (branchRef !== workspace.branchRef) {
      throw new Error("Managed workspace branch ownership changed");
    }
    if (worktreePath !== workspace.remoteWorktreePath) {
      throw new Error("Managed workspace effective cwd changed");
    }
    return {
      head,
      branchRef,
      worktreePath,
      stagedCount: parseCount(values.staged, "staged"),
      unstagedCount: parseCount(values.unstaged, "unstaged"),
      untrackedCount: parseCount(values.untracked, "untracked"),
    };
  }

  async fetchIntoDisposableRepository(
    workspace: ManagedSshWorkspace,
    destinationBareRepositoryPath: string,
  ): Promise<ManagedWorkspaceFetchResult> {
    const record = this.requireOwnedWorkspace(workspace);
    const destinationPath = resolve(destinationBareRepositoryPath);
    await assertDisposableBareRepository(destinationPath);
    const before = await this.observe(workspace);
    const destinationRef = `refs/ya-managed-gate-b/${workspace.workspaceId}`;
    await runGit(
      destinationPath,
      [
        "fetch",
        "--no-tags",
        "--force",
        this.target.gitRemoteUrl(workspace.remoteAnchorPath),
        `${workspace.branchRef}:${destinationRef}`,
      ],
      this.gitEnvironment(),
    );
    const fetchedHead = (
      await runGit(destinationPath, ["rev-parse", "--verify", destinationRef])
    ).stdout
      .toString("utf8")
      .trim();
    requireCommit(fetchedHead, "fetched workspace HEAD");
    await runGit(destinationPath, [
      "fsck",
      "--connectivity-only",
      "--no-dangling",
      fetchedHead,
    ]);
    const ancestry = await runGit(
      destinationPath,
      ["merge-base", "--is-ancestor", workspace.baseCommit, fetchedHead],
      undefined,
      [0, 1],
    );
    const after = await this.observe(workspace);
    const targetAdvancedDuringFetch = after.head !== fetchedHead;
    record.targetAdvancedDuringFetch = targetAdvancedDuringFetch;
    record.lastFetchedHead = targetAdvancedDuringFetch
      ? undefined
      : fetchedHead;
    return {
      announcedHead: before.head,
      fetchedHead,
      destinationRef,
      baseIsAncestor: ancestry.exitCode === 0,
      targetAdvancedDuringFetch,
    };
  }

  async cleanup(
    workspace: ManagedSshWorkspace,
    options: { explicitDiscard?: boolean } = {},
  ): Promise<ManagedWorkspaceCleanupResult> {
    const record = this.requireOwnedWorkspace(workspace);
    const observation = await this.observe(workspace);
    if (!options.explicitDiscard) {
      if (
        observation.stagedCount > 0 ||
        observation.unstagedCount > 0 ||
        observation.untrackedCount > 0
      ) {
        return { disposition: "retained", reason: "dirty", observation };
      }
      if (record.targetAdvancedDuringFetch) {
        return {
          disposition: "retained",
          reason: "target-advanced",
          observation,
        };
      }
      if (record.lastFetchedHead !== observation.head) {
        return {
          disposition: "retained",
          reason: "committed-but-unfetched",
          observation,
        };
      }
    }
    await this.deleteRemoteWorkspace(
      workspace,
      options.explicitDiscard === true,
    );
    this.records.delete(workspace.workspaceId);
    return {
      disposition: "deleted",
      explicitDiscard: options.explicitDiscard === true,
    };
  }

  async runFixtureCommand(
    workspace: ManagedSshWorkspace,
    command: string,
  ): Promise<string> {
    this.requireOwnedWorkspace(workspace);
    if (!command || command.includes("\0")) {
      throw new Error("Managed workspace fixture command is invalid");
    }
    const result = await this.target.runCommand(
      `set -eu; cd ${quoteShellWord(workspace.remoteWorktreePath)}; ${command}`,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return result.stdout;
  }

  static async createDisposableFetchRepository(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ya-managed-gate-b-fetch-"));
    try {
      await runGit(directory, ["init", "--bare", "--quiet"]);
      await runGit(directory, [
        "config",
        "yepanywhere.managedGateBFixture",
        "true",
      ]);
      return directory;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private gitEnvironment(): NodeJS.ProcessEnv {
    return {
      ...this.target.sshProcessEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: this.target.gitSshCommand(),
    };
  }

  private requireOwnedWorkspace(
    workspace: ManagedSshWorkspace,
  ): WorkspaceRecord {
    const record = this.records.get(workspace.workspaceId);
    if (
      !record ||
      record.workspace.repositoryIdentity !== workspace.repositoryIdentity ||
      record.workspace.remoteDirectory !== workspace.remoteDirectory
    ) {
      throw new Error("Managed workspace is not owned by this service");
    }
    return record;
  }

  private async createRemoteAnchor(
    workspace: ManagedSshWorkspace,
  ): Promise<void> {
    const workspaceRoot = `${this.target.remoteRoot}/workspaces`;
    const command = [
      "set -eu",
      "umask 077",
      "created=no",
      `cleanup_anchor() { if [ "$created" = yes ]; then rm -rf -- ${quoteShellWord(workspace.remoteDirectory)}; fi; }`,
      "trap cleanup_anchor EXIT HUP INT TERM",
      `mkdir -p ${quoteShellWord(this.target.remoteRoot)}`,
      `test "$(readlink -f ${quoteShellWord(this.target.remoteRoot)})" = ${quoteShellWord(this.target.remoteRoot)}`,
      `chmod 700 ${quoteShellWord(this.target.remoteRoot)}`,
      `mkdir -p ${quoteShellWord(workspaceRoot)}`,
      `chmod 700 ${quoteShellWord(workspaceRoot)}`,
      `if [ -e ${quoteShellWord(workspace.remoteDirectory)} ]; then printf 'workspace already exists\\n' >&2; exit 17; fi`,
      `mkdir ${quoteShellWord(workspace.remoteDirectory)}`,
      "created=yes",
      `chmod 700 ${quoteShellWord(workspace.remoteDirectory)}`,
      `mkdir ${quoteShellWord(`${workspace.remoteDirectory}/writer-lease`)}`,
      `printf '%s\\n%s\\n%s\\n' ${quoteShellWord(workspace.workspaceId)} ${quoteShellWord(workspace.repositoryIdentity)} ${quoteShellWord(workspace.baseCommit)} > ${quoteShellWord(`${workspace.remoteDirectory}/identity`)}`,
      `chmod 600 ${quoteShellWord(`${workspace.remoteDirectory}/identity`)}`,
      `git init --bare --quiet ${quoteShellWord(workspace.remoteAnchorPath)}`,
      `git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} config yepanywhere.workspaceId ${quoteShellWord(workspace.workspaceId)}`,
      `git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} config yepanywhere.repositoryIdentity ${quoteShellWord(workspace.repositoryIdentity)}`,
      "created=no",
      "trap - EXIT HUP INT TERM",
    ].join("; ");
    await this.target.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS });
  }

  private async createAndVerifyRemoteWorktree(
    workspace: ManagedSshWorkspace,
  ): Promise<void> {
    const command = [
      "set -eu",
      verifyIdentityCommand(workspace),
      `test "$(git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} config --get yepanywhere.workspaceId)" = ${quoteShellWord(workspace.workspaceId)}`,
      `test "$(git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} config --get yepanywhere.repositoryIdentity)" = ${quoteShellWord(workspace.repositoryIdentity)}`,
      `git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} worktree add --quiet ${quoteShellWord(workspace.remoteWorktreePath)} ${quoteShellWord(workspace.branchRef.slice("refs/heads/".length))}`,
      workspaceObservationCommand(workspace),
    ].join("; ");
    const result = await this.target.runCommand(command, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const values = parseKeyValueOutput(result.stdout);
    if (
      values.head !== workspace.baseCommit ||
      values.branch !== workspace.branchRef ||
      values.worktree !== workspace.remoteWorktreePath
    ) {
      throw new Error("Managed target worktree failed identity verification");
    }
  }

  private async discardPreparedWorkspace(
    workspace: ManagedSshWorkspace,
  ): Promise<void> {
    const command = [
      "set -eu",
      verifyIdentityCommand(workspace),
      `if [ -d ${quoteShellWord(workspace.remoteWorktreePath)} ]; then git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} worktree remove --force ${quoteShellWord(workspace.remoteWorktreePath)} 2>/dev/null || true; fi`,
      `rm -rf -- ${quoteShellWord(workspace.remoteDirectory)}`,
    ].join("; ");
    await this.target.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS });
  }

  private async deleteRemoteWorkspace(
    workspace: ManagedSshWorkspace,
    force: boolean,
  ): Promise<void> {
    const forceArgument = force ? " --force" : "";
    const command = [
      "set -eu",
      verifyIdentityCommand(workspace),
      `git --git-dir=${quoteShellWord(workspace.remoteAnchorPath)} worktree remove${forceArgument} ${quoteShellWord(workspace.remoteWorktreePath)}`,
      `rm -rf -- ${quoteShellWord(workspace.remoteDirectory)}`,
      `test ! -e ${quoteShellWord(workspace.remoteDirectory)}`,
    ].join("; ");
    await this.target.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS });
  }
}

async function inspectSource(
  sourcePath: string,
): Promise<ManagedSourceDisclosure> {
  const [head, branch, staged, unstaged, untracked] = await Promise.all([
    runGit(sourcePath, ["rev-parse", "--verify", "HEAD"]),
    runGit(sourcePath, ["symbolic-ref", "--quiet", "HEAD"], undefined, [0, 1]),
    runGit(sourcePath, ["diff", "--cached", "--name-only", "-z"]),
    runGit(sourcePath, ["diff", "--name-only", "-z"]),
    runGit(sourcePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return {
    baseCommit: requireCommit(
      head.stdout.toString("utf8").trim(),
      "source HEAD",
    ),
    branch:
      branch.exitCode === 0 ? branch.stdout.toString("utf8").trim() : null,
    stagedCount: countNulRecords(staged.stdout),
    unstagedCount: countNulRecords(unstaged.stdout),
    untrackedCount: countNulRecords(untracked.stdout),
  };
}

async function assertDisposableBareRepository(path: string): Promise<void> {
  const [bare, marker] = await Promise.all([
    runGit(path, ["rev-parse", "--is-bare-repository"]),
    runGit(
      path,
      ["config", "--get", "yepanywhere.managedGateBFixture"],
      undefined,
      [0, 1],
    ),
  ]);
  if (
    bare.stdout.toString("utf8").trim() !== "true" ||
    marker.stdout.toString("utf8").trim() !== "true"
  ) {
    throw new Error(
      "Managed workspace fetch destination must be a marked disposable bare repository",
    );
  }
}

function workspaceObservationCommand(workspace: ManagedSshWorkspace): string {
  const worktree = quoteShellWord(workspace.remoteWorktreePath);
  return [
    verifyIdentityCommand(workspace),
    `head=$(git -C ${worktree} rev-parse --verify HEAD)`,
    `branch=$(git -C ${worktree} symbolic-ref HEAD)`,
    `effective_worktree=$(git -C ${worktree} rev-parse --show-toplevel)`,
    `staged=$(git -C ${worktree} diff --cached --name-only -z | tr -cd '\\000' | wc -c | tr -d ' ')`,
    `unstaged=$(git -C ${worktree} diff --name-only -z | tr -cd '\\000' | wc -c | tr -d ' ')`,
    `untracked=$(git -C ${worktree} ls-files --others --exclude-standard -z | tr -cd '\\000' | wc -c | tr -d ' ')`,
    'printf \'head=%s\\nbranch=%s\\nworktree=%s\\nstaged=%s\\nunstaged=%s\\nuntracked=%s\\n\' "$head" "$branch" "$effective_worktree" "$staged" "$unstaged" "$untracked"',
  ].join("; ");
}

function verifyIdentityCommand(workspace: ManagedSshWorkspace): string {
  const identity = quoteShellWord(`${workspace.remoteDirectory}/identity`);
  return [
    `test -f ${identity}`,
    `test "$(sed -n '1p' ${identity})" = ${quoteShellWord(workspace.workspaceId)}`,
    `test "$(sed -n '2p' ${identity})" = ${quoteShellWord(workspace.repositoryIdentity)}`,
    `test "$(sed -n '3p' ${identity})" = ${quoteShellWord(workspace.baseCommit)}`,
    `test -d ${quoteShellWord(`${workspace.remoteDirectory}/writer-lease`)}`,
  ].join("; ");
}

function parseKeyValueOutput(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error("Managed workspace returned malformed output");
    const key = line.slice(0, separator);
    if (!/^[a-z_]+$/.test(key) || key in values) {
      throw new Error(
        "Managed workspace returned duplicate or malformed output",
      );
    }
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`Managed workspace omitted ${key}`);
  return value;
}

function parseCount(value: string | undefined, label: string): number {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error(`Managed workspace returned an invalid ${label} count`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`Managed workspace returned an unsafe ${label} count`);
  }
  return count;
}

function countNulRecords(value: Buffer): number {
  let count = 0;
  for (const byte of value) if (byte === 0) count += 1;
  return count;
}

function assertWorkspaceId(value: string): void {
  if (!WORKSPACE_ID_PATTERN.test(value)) {
    throw new Error("Managed workspace ID must be an opaque UUID");
  }
}

function requireCommit(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(`${label} is not a full Git object ID`);
  }
  return value;
}

async function runGit(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  acceptedExitCodes: number[] = [0],
): Promise<GitResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let completed = false;
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer | string,
    ): Buffer<ArrayBufferLike> => {
      const bytes = Buffer.from(chunk);
      if (current.byteLength + bytes.byteLength > GIT_MAX_OUTPUT_BYTES) {
        stop(new Error("Managed workspace Git output exceeded its bound"));
        const remaining = Math.max(
          0,
          GIT_MAX_OUTPUT_BYTES - current.byteLength,
        );
        return Buffer.concat([current, bytes.subarray(0, remaining)]);
      }
      return Buffer.concat([current, bytes]);
    };
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            `Managed workspace Git command timed out after ${GIT_TIMEOUT_MS}ms`,
          ),
        ),
      GIT_TIMEOUT_MS,
    );
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectPromise(error);
    });
    child.once("close", (exitCode) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const code = exitCode ?? -1;
      const stderrText = stderr.toString("utf8");
      if (failure) {
        rejectPromise(new Error(`${failure.message}: ${stderrText}`));
        return;
      }
      if (!acceptedExitCodes.includes(code)) {
        rejectPromise(
          new Error(
            `Managed workspace Git command failed (${code}): ${stderrText.trim()}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr: stderrText, exitCode: code });
    });
  });
}
