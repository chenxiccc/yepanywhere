import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ManagedRunnerArtifactManifest,
  ManagedSshOperationError,
  ManagedSshTarget,
} from "../../../src/sdk/providers/managed-ssh-target.js";

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

async function fixtureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function waitForFrame(
  frames: Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("managed SSH runner frame timed out");
}

async function createArtifact(directory: string): Promise<{
  artifactPath: string;
  manifest: ManagedRunnerArtifactManifest;
}> {
  const artifactPath = join(directory, "fixture-runner.mjs");
  const source = `#!/usr/bin/env node
let buffer = "";
let accepted = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type === "hello") send({ type: "helloAck", leaseId: frame.leaseId, protocolVersion: 1 });
    if (frame.type === "launch") { accepted = true; send({ type: "launchAccepted", leaseId: frame.leaseId }); }
    if (frame.type === "shutdown") { send({ type: "shutdownComplete", leaseId: frame.leaseId }); process.stdin.destroy(); }
  }
});
process.stdin.on("close", () => { process.exitCode = accepted ? 0 : 1; });
`;
  await writeFile(artifactPath, source, { mode: 0o700 });
  const bytes = await readFile(artifactPath);
  return {
    artifactPath,
    manifest: {
      artifactFormatVersion: 1,
      runnerProtocolVersion: 1,
      providerSessionProtocolVersion: 1,
      entrypoint: "runner.mjs",
      target: {
        os: "linux",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
      },
      node: { range: ">=20.12" },
      artifact: {
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}

describe.skipIf(process.platform === "win32")("ManagedSshTarget", () => {
  it("uses bounded, non-PTY, policy-preserving inspection", async () => {
    const directory = await fixtureDirectory("managed-ssh-target-");
    const recordPath = join(directory, "ssh-record.jsonl");
    const target = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot: join(directory, "remote"),
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      spawnEnvironment: {
        ...process.env,
        ANTHROPIC_API_KEY: "must-not-reach-ssh",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-ssh",
        OPENAI_API_KEY: "must-not-reach-ssh",
        YA_FAKE_SSH_RECORD: recordPath,
      },
    });

    const inspection = await target.inspect();
    await target.runCommand(
      "test -z \"${ANTHROPIC_API_KEY+x}\"; test -z \"${CLAUDE_CODE_OAUTH_TOKEN+x}\"; test -z \"${OPENAI_API_KEY+x}\"",
    );

    expect(inspection.platform).toBe("Linux");
    expect(inspection.node).toMatchObject({
      available: true,
      compatible: true,
    });
    expect(inspection.git.available).toBe(true);
    expect(inspection.managedRootState).toBe("creatable");
    expect(inspection.runnerCacheState).toBe("absent");
    expect(await readdir(directory)).toEqual(["ssh-record.jsonl"]);
    const records = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const record of records) {
      expect(record.args).toContain("-T");
      expect(record.args).not.toContain("-t");
      expect(record.args).toContain("BatchMode=yes");
      expect(record.args.join(" ")).not.toContain("StrictHostKeyChecking");
      expect(record.sensitiveEnvironmentPresent).toBe(false);
    }
  });

  it("verifies and atomically caches an artifact before a clean runner launch", async () => {
    const directory = await fixtureDirectory("managed-ssh-artifact-");
    const remoteRoot = join(directory, "remote");
    const target = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      terminationGraceMs: 100,
    });
    const { artifactPath, manifest } = await createArtifact(directory);

    const inspection = await target.inspect();
    const cold = await target.installRunnerArtifact(artifactPath, manifest, {
      inspection,
    });
    const warm = await target.installRunnerArtifact(artifactPath, manifest, {
      inspection,
    });

    expect(cold.cacheHit).toBe(false);
    expect(warm.cacheHit).toBe(true);
    const cached = join(
      remoteRoot,
      "runner-cache",
      manifest.artifact.sha256,
      "runner.mjs",
    );
    expect((await stat(cached)).mode & 0o777).toBe(0o700);
    expect(
      (await readdir(join(remoteRoot, "runner-cache"))).filter((name) =>
        name.startsWith(".incoming-"),
      ),
    ).toEqual([]);

    const launch = target.launchRunner({ manifest, cwd: remoteRoot });
    const frames: Record<string, unknown>[] = [];
    let buffer = "";
    launch.output.setEncoding("utf8");
    launch.output.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line);
        frames.push(frame);
        if (frame.type === "launchAccepted") launch.markLaunchAccepted();
        if (frame.type === "shutdownComplete") {
          launch.markCooperativeCompletion();
        }
      }
    });
    launch.input.write(
      `${JSON.stringify({ type: "hello", protocolVersion: 1, leaseId: "fixture-lease" })}\n`,
    );
    await waitForFrame(frames, (frame) => frame.type === "helloAck");
    launch.input.write(
      `${JSON.stringify({ type: "launch", leaseId: "fixture-lease" })}\n`,
    );
    await waitForFrame(frames, (frame) => frame.type === "launchAccepted");
    launch.input.write(
      `${JSON.stringify({ type: "shutdown", leaseId: "fixture-lease" })}\n`,
    );
    await waitForFrame(frames, (frame) => frame.type === "shutdownComplete");
    expect(await launch.terminal).toEqual({
      classification: "clean",
      code: 0,
      signal: null,
      stderr: "",
    });
  });

  it("classifies failure before acceptance separately from later uncertainty", async () => {
    const directory = await fixtureDirectory("managed-ssh-classification-");
    const { artifactPath, manifest } = await createArtifact(directory);
    const remoteRoot = join(directory, "remote");
    const installer = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      terminationGraceMs: 50,
    });
    await installer.installRunnerArtifact(artifactPath, manifest, {
      inspection: await installer.inspect(),
    });

    const failedTarget = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      spawnEnvironment: {
        ...process.env,
        YA_FAKE_SSH_PRECONNECT_FAILURE: "1",
      },
      terminationGraceMs: 50,
    });
    const failed = failedTarget.launchRunner({ manifest, cwd: remoteRoot });
    expect(await failed.terminal).toMatchObject({
      classification: "pre-launch-failure",
      code: 255,
    });

    const droppedTarget = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      spawnEnvironment: { ...process.env, YA_FAKE_SSH_DROP_AFTER_MS: "150" },
      terminationGraceMs: 50,
    });
    const dropped = droppedTarget.launchRunner({ manifest, cwd: remoteRoot });
    let stdout = "";
    dropped.output.setEncoding("utf8");
    dropped.output.on("data", (chunk: string) => {
      stdout += chunk;
    });
    dropped.input.write(
      `${JSON.stringify({ type: "hello", protocolVersion: 1, leaseId: "dropped-lease" })}\n`,
    );
    dropped.input.write(
      `${JSON.stringify({ type: "launch", leaseId: "dropped-lease" })}\n`,
    );
    const deadline = Date.now() + 1_000;
    while (!stdout.includes("launchAccepted") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stdout).toContain("launchAccepted");
    dropped.markLaunchAccepted();
    expect(await dropped.terminal).toMatchObject({
      classification: "uncertain-after-acceptance",
    });
  });

  it("does not publish or retain a partial interrupted transfer", async () => {
    const directory = await fixtureDirectory("managed-ssh-partial-");
    const remoteRoot = join(directory, "remote");
    const artifactPath = join(directory, "large-runner.mjs");
    const bytes = Buffer.alloc(512 * 1024, 0x20);
    await writeFile(artifactPath, bytes, { mode: 0o700 });
    const manifest: ManagedRunnerArtifactManifest = {
      artifactFormatVersion: 1,
      runnerProtocolVersion: 1,
      providerSessionProtocolVersion: 1,
      entrypoint: "runner.mjs",
      target: {
        os: "linux",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
      },
      node: { range: ">=20.12" },
      artifact: {
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const target = new ManagedSshTarget({
      hostAlias: "fixture-linux",
      remoteRoot,
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
      spawnEnvironment: {
        ...process.env,
        YA_FAKE_SSH_TRUNCATE_INPUT_AFTER_BYTES: "4096",
      },
    });

    await expect(
      target.installRunnerArtifact(artifactPath, manifest, {
        inspection: await target.inspect(),
      }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const cacheEntries = await readdir(join(remoteRoot, "runner-cache"));
    expect(cacheEntries).toEqual([]);
  });

  it("rejects unsafe aliases, paths, oversized output, and corrupt local bytes", async () => {
    expect(
      () =>
        new ManagedSshTarget({
          hostAlias: "-oProxyCommand=bad",
          remoteRoot: "/tmp/managed",
        }),
    ).toThrow("configured host alias");
    expect(
      () =>
        new ManagedSshTarget({
          hostAlias: "fixture",
          remoteRoot: "/tmp/../escape",
        }),
    ).toThrow("contained absolute POSIX path");

    const directory = await fixtureDirectory("managed-ssh-bounds-");
    const target = new ManagedSshTarget({
      hostAlias: "fixture",
      remoteRoot: join(directory, "remote"),
      sshCommand: fakeSshPath,
      nodeCommand: process.execPath,
    });
    await expect(
      target.runCommand("printf '123456789'", { maxStdoutBytes: 4 }),
    ).rejects.toBeInstanceOf(ManagedSshOperationError);
    const { artifactPath, manifest } = await createArtifact(directory);
    const inspection = await target.inspect();
    await expect(
      target.installRunnerArtifact(artifactPath, manifest, {
        inspection: { ...inspection, platform: "Darwin" },
      }),
    ).rejects.toThrow("require a Linux target");
    await chmod(artifactPath, 0o700);
    await writeFile(artifactPath, "corrupt", { mode: 0o700 });
    await expect(
      target.installRunnerArtifact(artifactPath, manifest, {
        inspection,
      }),
    ).rejects.toThrow("size does not match");
  });
});
