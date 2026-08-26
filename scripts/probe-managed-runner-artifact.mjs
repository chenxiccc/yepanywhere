#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const artifactPath = requiredPath("--artifact");
const manifestPath = requiredPath("--manifest");
const cacheDirectory = requiredPath("--cache-dir");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

validateManifest(manifest);
const controllerVerificationStartedAt = performance.now();
await verifyFile(artifactPath, manifest.artifact);
const controllerVerificationMs = elapsed(controllerVerificationStartedAt);

const coldInstall = await installArtifact();
const coldRun = await probeRunner(coldInstall.path);
const warmInstall = await installArtifact();
const warmRun = await probeRunner(warmInstall.path);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    artifactFormatVersion: manifest.artifactFormatVersion,
    runnerProtocolVersion: manifest.runnerProtocolVersion,
    providerSessionProtocolVersion: manifest.providerSessionProtocolVersion,
    buildIdentity: manifest.buildIdentity,
    target: manifest.target,
    nodeVersion: process.version,
    prerequisites: [
      "Linux",
      manifest.node.range,
      "target Codex executable for Codex sessions",
    ],
    artifactBytes: manifest.artifact.byteSize,
    artifactSha256: manifest.artifact.sha256,
    controllerVerificationMs,
    coldInstall,
    coldRun,
    warmInstall,
    warmRun,
  })}\n`,
);

function requiredPath(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return resolve(value);
}

function validateManifest(value) {
  if (
    !value ||
    value.artifactFormatVersion !== 1 ||
    value.runnerProtocolVersion !== 1 ||
    value.providerSessionProtocolVersion !== 1 ||
    value.entrypoint !== "runner.mjs" ||
    value.target?.os !== "linux" ||
    value.target?.architecture !== arch() ||
    value.node?.range !== ">=20.12" ||
    !Number.isSafeInteger(value.artifact?.byteSize) ||
    value.artifact.byteSize <= 0 ||
    !/^[0-9a-f]{64}$/.test(value.artifact?.sha256 ?? "")
  ) {
    throw new Error("Managed runner manifest is invalid or incompatible");
  }
  if (platform() !== "linux") {
    throw new Error("This Gate A artifact probe requires Linux");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) {
    throw new Error("Managed runner requires Node.js 20.12 or newer");
  }
}

async function verifyFile(path, expected) {
  const file = await readFile(path);
  if (file.byteLength !== expected.byteSize) {
    throw new Error(`Artifact size mismatch for ${basename(path)}`);
  }
  const digest = createHash("sha256").update(file).digest("hex");
  if (digest !== expected.sha256) {
    throw new Error(`Artifact digest mismatch for ${basename(path)}`);
  }
}

async function installArtifact() {
  const startedAt = performance.now();
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700);
  const finalDirectory = join(cacheDirectory, manifest.artifact.sha256);
  const finalPath = join(finalDirectory, manifest.entrypoint);
  try {
    await verifyFile(finalPath, manifest.artifact);
    await chmod(finalDirectory, 0o700);
    await chmod(finalPath, 0o700);
    return {
      cacheHit: true,
      installMs: elapsed(startedAt),
      path: finalPath,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const stagingDirectory = join(
    cacheDirectory,
    `.incoming-${process.pid}-${randomUUID()}`,
  );
  const stagingPath = join(stagingDirectory, manifest.entrypoint);
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    await copyFile(artifactPath, stagingPath);
    await chmod(stagingPath, 0o700);
    await verifyFile(stagingPath, manifest.artifact);
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await rm(stagingDirectory, { recursive: true, force: true });
      await verifyFile(finalPath, manifest.artifact);
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    cacheHit: false,
    installMs: elapsed(startedAt),
    path: finalPath,
  };
}

async function probeRunner(path) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [path], {
    cwd: process.cwd(),
    env: { ...process.env, YEP_MANAGED_RUNNER_ALLOW_FAKE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childExit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let stdoutBuffer = "";
  let stderr = "";
  const frames = [];
  const waiters = new Set();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
    for (const wake of waiters) wake();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 64 * 1024) {
      child.kill("SIGKILL");
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const leaseId = `probe-${randomUUID()}`;

  send({ type: "hello", protocolVersion: 1, leaseId });
  await waitForFrame((frame) => frame.type === "helloAck");
  const helloMs = elapsed(startedAt);
  send({
    type: "launch",
    leaseId,
    controlId: "launch",
    provider: "fake",
    options: { cwd: process.cwd() },
  });
  await waitForFrame((frame) => frame.type === "launchAccepted");
  const launchMs = elapsed(startedAt);

  send({
    type: "queuePush",
    leaseId,
    controlId: "echo",
    message: { text: "gate-a", uuid: "gate-a-message", tempId: "gate-a-temp" },
  });
  const echoed = await waitForFrame(
    (frame) =>
      frame.type === "event" &&
      frame.message?.message?.content === "echo:gate-a",
  );
  const turnMs = elapsed(startedAt);
  send({ type: "ack", leaseId, controlId: "ack", sequence: echoed.sequence });

  send({
    type: "queuePush",
    leaseId,
    controlId: "approval",
    message: { text: "approval:gate_a" },
  });
  const approval = await waitForFrame((frame) => frame.type === "approval");
  send({
    type: "approvalResult",
    leaseId,
    controlId: "approval-result",
    requestId: approval.requestId,
    result: { behavior: "allow" },
  });
  await waitForFrame(
    (frame) =>
      frame.type === "event" &&
      frame.message?.message?.content === "approval:allow",
  );

  send({
    type: "rpc",
    leaseId,
    controlId: "liveness",
    id: 1,
    method: "probeLiveness",
    args: [],
  });
  await waitForFrame(
    (frame) =>
      frame.type === "rpcResult" && frame.id === 1 && frame.ok === true,
  );
  send({
    type: "queuePush",
    leaseId,
    controlId: "hold",
    message: { text: "hold" },
  });
  await waitForFrame(
    (frame) =>
      frame.type === "providerRetention" && frame.value?.retained === true,
  );
  send({
    type: "rpc",
    leaseId,
    controlId: "interrupt",
    id: 2,
    method: "interrupt",
    args: [],
  });
  await waitForFrame(
    (frame) =>
      frame.type === "event" &&
      frame.message?.message?.content === "interrupted",
  );
  send({ type: "shutdown", leaseId, controlId: "shutdown" });
  await waitForFrame((frame) => frame.type === "shutdownComplete");
  child.stdin.end();
  const exit = await childExit;
  if (exit.error) throw exit.error;
  if (exit.code !== 0 || exit.signal || stderr) {
    throw new Error(
      `Managed runner probe failed: exit=${exit.code} signal=${exit.signal} stderr=${stderr}`,
    );
  }
  return {
    helloMs,
    launchMs,
    firstTurnMs: turnMs,
    totalMs: elapsed(startedAt),
    frames: frames.length,
  };

  async function waitForFrame(predicate, timeoutMs = 5_000) {
    const existing = frames.find(predicate);
    if (existing) return existing;
    return await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(check);
        child.kill("SIGKILL");
        reject(
          new Error(
            `Timed out waiting for managed runner frame; frames=${JSON.stringify(frames)} stderr=${stderr}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        const match = frames.find(predicate);
        if (!match) return;
        clearTimeout(timeout);
        waiters.delete(check);
        resolvePromise(match);
      };
      waiters.add(check);
    });
  }
}

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
