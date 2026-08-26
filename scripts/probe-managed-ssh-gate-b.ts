#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ManagedSshRunnerLaunch,
  ManagedSshTarget,
  readManagedRunnerManifest,
} from "../packages/server/src/sdk/providers/managed-ssh-target.js";
import { ManagedSshWorkspaceService } from "../packages/server/src/sdk/providers/managed-ssh-workspace.js";

const hostAlias = requiredArgument("--host");
const remoteRoot = requiredArgument("--remote-root");
const artifactPath = resolve(requiredArgument("--artifact"));
const manifestPath = resolve(requiredArgument("--manifest"));
const nodeCommand = optionalArgument("--node") ?? "node";
const sshCommand = optionalArgument("--ssh") ?? "ssh";
const cleanupTargetRoot = process.argv.includes("--cleanup-target-root");
const localFixture = await mkdtemp(
  join(tmpdir(), "ya-managed-gate-b-controller-"),
);
let disposableFetchRepository: string | undefined;

const target = new ManagedSshTarget({
  hostAlias,
  remoteRoot,
  nodeCommand,
  sshCommand,
  operationTimeoutMs: 30_000,
});
let workspaceService: ManagedSshWorkspaceService | undefined;
let workspace:
  | Awaited<ReturnType<ManagedSshWorkspaceService["prepare"]>>
  | undefined;

try {
  const manifest = await readManagedRunnerManifest(manifestPath);
  const inspection = await target.inspect();
  if (inspection.platform !== "Linux") {
    throw new Error(
      `Gate B requires a Linux target, observed ${inspection.platform}`,
    );
  }
  const targetArchitecture = normalizeTargetArchitecture(
    inspection.architecture,
  );
  if (targetArchitecture !== manifest.target.architecture) {
    throw new Error(
      `Runner targets ${manifest.target.architecture}, target reported ${inspection.architecture}`,
    );
  }
  if (!inspection.node.compatible) {
    throw new Error(
      `Gate B runner requires Node.js >=20.12, observed ${inspection.node.version ?? "unavailable"}`,
    );
  }
  if (!inspection.git.available) {
    throw new Error("Gate B workspace requires target Git");
  }
  workspaceService = new ManagedSshWorkspaceService(target, inspection);

  const coldInstall = await target.installRunnerArtifact(
    artifactPath,
    manifest,
    {
      inspection,
    },
  );
  const warmInstall = await target.installRunnerArtifact(
    artifactPath,
    manifest,
    {
      inspection,
    },
  );
  const runner = await probeRunner(target, manifest, remoteRoot);

  const source = join(localFixture, "source");
  await mkdir(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.email", "gate-b@example.invalid"]);
  git(source, ["config", "user.name", "Gate B Controller Fixture"]);
  await writeFile(join(source, "tracked.txt"), "committed base\n");
  await writeFile(join(source, "staged.txt"), "committed base\n");
  git(source, ["add", "tracked.txt", "staged.txt"]);
  git(source, ["commit", "--quiet", "-m", "gate b base"]);
  await writeFile(join(source, "tracked.txt"), "excluded unstaged\n");
  await writeFile(join(source, "staged.txt"), "excluded staged\n");
  git(source, ["add", "staged.txt"]);
  await writeFile(join(source, "untracked.txt"), "excluded untracked\n");
  const sourceBefore = sourceFingerprint(source);

  workspace = await workspaceService.prepare(source);
  await workspaceService.runFixtureCommand(
    workspace,
    "git config user.email gate-b-target@example.invalid; git config user.name 'Gate B Target Fixture'",
  );
  await workspaceService.runFixtureCommand(
    workspace,
    "printf 'first\\n' > target-result.txt; git add target-result.txt; git commit --quiet -m first",
  );
  await workspaceService.runFixtureCommand(
    workspace,
    "printf 'second\\n' >> target-result.txt; git add target-result.txt; git commit --quiet -m second",
  );
  const preAmendHead = (await workspaceService.observe(workspace)).head;
  await workspaceService.runFixtureCommand(
    workspace,
    "printf 'amended\\n' >> target-result.txt; git add target-result.txt; git commit --quiet --amend -m amended",
  );
  const finalObservation = await workspaceService.observe(workspace);
  if (finalObservation.head === preAmendHead) {
    throw new Error("Gate B amend did not replace the target commit");
  }

  disposableFetchRepository =
    await ManagedSshWorkspaceService.createDisposableFetchRepository();
  const fetchResult = await workspaceService.fetchIntoDisposableRepository(
    workspace,
    disposableFetchRepository,
  );
  const sourceAfter = sourceFingerprint(source);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error("Gate B source checkout changed during target round trip");
  }
  const cleanup = await workspaceService.cleanup(workspace);
  workspace = undefined;
  if (cleanup.disposition !== "deleted") {
    throw new Error(`Gate B clean workspace was retained: ${cleanup.reason}`);
  }

  if (cleanupTargetRoot) {
    assertDisposableTargetRoot(remoteRoot);
    await target.runCommand(
      `set -eu; test ! -e '${remoteRoot}/workspaces' || test -z "$(find '${remoteRoot}/workspaces' -mindepth 1 -maxdepth 1 -print -quit)"; rm -rf -- '${remoteRoot}'; test ! -e '${remoteRoot}'`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      controller: { platform: process.platform, architecture: process.arch },
      inspection,
      artifact: {
        byteSize: manifest.artifact.byteSize,
        sha256: manifest.artifact.sha256,
        coldInstall,
        warmInstall,
      },
      runner,
      workspace: {
        workspaceId:
          cleanup.disposition === "deleted"
            ? "opaque-and-deleted"
            : "unexpected",
        baseCommit: sourceBefore.head,
        excludedDirty: {
          staged: 1,
          unstaged: 1,
          untracked: 1,
        },
        preAmendHead,
        fetchedHead: fetchResult.fetchedHead,
        baseIsAncestor: fetchResult.baseIsAncestor,
        targetAdvancedDuringFetch: fetchResult.targetAdvancedDuringFetch,
        sourceCheckoutUnchanged: true,
        cleanup: cleanup.disposition,
      },
      targetRootCleanup: cleanupTargetRoot ? "deleted" : "retained-cache-only",
    })}\n`,
  );
} catch (error) {
  if (workspace && workspaceService) {
    await workspaceService
      .cleanup(workspace, { explicitDiscard: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await rm(localFixture, { recursive: true, force: true });
  if (disposableFetchRepository) {
    await rm(disposableFetchRepository, { recursive: true, force: true });
  }
}

async function probeRunner(
  target: ManagedSshTarget,
  manifest: Awaited<ReturnType<typeof readManagedRunnerManifest>>,
  cwd: string,
): Promise<{
  protocolFrames: number;
  launchAccepted: true;
  fakeTurnCompleted: true;
  cleanup: "clean";
}> {
  const launch = target.launchRunner({
    manifest,
    cwd,
    allowFakeProvider: true,
  });
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  launch.output.setEncoding("utf8");
  launch.output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "launchAccepted") launch.markLaunchAccepted();
      if (frame.type === "shutdownComplete") launch.markCooperativeCompletion();
    }
  });
  const leaseId = `gate-b-${randomUUID()}`;
  send(launch, { type: "hello", protocolVersion: 1, leaseId });
  await waitForFrame(frames, (frame) => frame.type === "helloAck");
  send(launch, {
    type: "launch",
    leaseId,
    controlId: "launch",
    provider: "fake",
    options: { cwd },
  });
  await waitForFrame(frames, (frame) => frame.type === "launchAccepted");
  send(launch, {
    type: "queuePush",
    leaseId,
    controlId: "turn",
    message: { text: "gate-b", uuid: "gate-b-message" },
  });
  await waitForFrame(
    frames,
    (frame) =>
      frame.type === "event" &&
      (
        (frame.message as Record<string, unknown> | undefined)?.message as
          | Record<string, unknown>
          | undefined
      )?.content === "echo:gate-b",
  );
  send(launch, { type: "shutdown", leaseId, controlId: "shutdown" });
  await waitForFrame(frames, (frame) => frame.type === "shutdownComplete");
  const terminal = await launch.terminal;
  if (terminal.classification !== "clean") {
    throw new Error(
      `Gate B runner did not terminate cleanly: ${terminal.classification}`,
    );
  }
  return {
    protocolFrames: frames.length,
    launchAccepted: true,
    fakeTurnCompleted: true,
    cleanup: "clean",
  };
}

function send(launch: ManagedSshRunnerLaunch, value: unknown): void {
  launch.input.write(`${JSON.stringify(value)}\n`);
}

async function waitForFrame(
  frames: Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Gate B runner protocol frame timed out");
}

function sourceFingerprint(cwd: string): Record<string, string> {
  return {
    head: git(cwd, ["rev-parse", "HEAD"]),
    branch: git(cwd, ["symbolic-ref", "HEAD"]),
    status: git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    diff: git(cwd, ["diff", "--binary"]),
    cachedDiff: git(cwd, ["diff", "--cached", "--binary"]),
    trackedBytes: readFileSync(join(cwd, "tracked.txt"), "hex"),
    stagedBytes: readFileSync(join(cwd, "staged.txt"), "hex"),
    untrackedBytes: readFileSync(join(cwd, "untracked.txt"), "hex"),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function normalizeTargetArchitecture(value: string): "x64" | "arm64" {
  if (value === "x86_64" || value === "amd64") return "x64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  throw new Error(`Unsupported Gate B target architecture ${value}`);
}

function assertDisposableTargetRoot(value: string): void {
  if (
    !value.startsWith("/tmp/ya-managed-gate-b-") ||
    basename(value).length <= "ya-managed-gate-b-".length
  ) {
    throw new Error(
      "--cleanup-target-root requires /tmp/ya-managed-gate-b-<unique>",
    );
  }
}

function requiredArgument(name: string): string {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
