#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const READY_TIMEOUT_MS = 10_000;
const MAX_PID_LINE_BYTES = 64;

const namespaceSetupScript = String.raw`
set -eu
printf '%s\n' "$$" >&5
IFS= read -r permission <&4
test "$permission" = go

ip_path=$1
shift
route_count=$1
shift

"$ip_path" link set lo up
index=0
while test "$index" -lt "$route_count"; do
  "$ip_path" route replace prohibit "$1" metric 1
  shift
  index=$((index + 1))
done
"$ip_path" -6 addr flush dev lo
"$ip_path" -6 route replace prohibit ::/0 metric 1

exec "$@"
`;

function parseConfiguration(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid session sandbox network configuration: ${error}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error("Session sandbox network configuration must be an object");
  }
  for (const name of ["unsharePath", "slirpPath", "ipPath", "bwrapPath"]) {
    if (typeof value[name] !== "string" || !value[name].startsWith("/")) {
      throw new Error(
        `Session sandbox network configuration has invalid ${name}`,
      );
    }
  }
  if (
    !Array.isArray(value.bwrapArgs) ||
    !value.bwrapArgs.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.blockedDestinations) ||
    !value.blockedDestinations.every((entry) => typeof entry === "string") ||
    typeof value.passProjectFd !== "boolean"
  ) {
    throw new Error("Session sandbox network configuration has invalid arrays");
  }
  return value;
}

function childExit(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(new Error(`${label}: ${error.message}`)),
    );
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readNamespacePid(stream, exited) {
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(
        new Error(`Could not read network namespace pid: ${error.message}`),
      );
    };
    const onData = (chunk) => {
      value += chunk.toString("utf8");
      if (value.length > MAX_PID_LINE_BYTES) {
        cleanup();
        reject(new Error("Network namespace pid response was too large"));
        return;
      }
      const newline = value.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      const parsed = Number(value.slice(0, newline));
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        reject(new Error("Network namespace launcher returned an invalid pid"));
        return;
      }
      resolve(parsed);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    void exited.then(({ code, signal }) => {
      cleanup();
      reject(
        new Error(
          `Network namespace exited before setup (${signal ? `signal ${signal}` : `status ${code}`})`,
        ),
      );
    }, reject);
  });
}

function waitForReady(stream, exited) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("slirp4netns did not become ready in time"));
    }, READY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("error", onError);
    };
    const onData = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(
        new Error(`Could not read slirp4netns readiness: ${error.message}`),
      );
    };
    stream.once("data", onData);
    stream.once("error", onError);
    void exited.then(({ code, signal }) => {
      cleanup();
      reject(
        new Error(
          `slirp4netns exited before readiness (${signal ? `signal ${signal}` : `status ${code}`})`,
        ),
      );
    }, reject);
  });
}

function exitCodeForSignal(signal) {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

async function main() {
  const [rawConfiguration, command, ...commandArgs] = process.argv.slice(2);
  if (!rawConfiguration || !command) {
    throw new Error(
      "Usage: session-sandbox-network-launcher <configuration> <command> [args...]",
    );
  }
  const configuration = parseConfiguration(rawConfiguration);
  const namespaceProcess = spawn(
    configuration.unsharePath,
    [
      "--user",
      "--map-root-user",
      "--net",
      "--",
      "/bin/sh",
      "-c",
      namespaceSetupScript,
      "session-sandbox-network",
      configuration.ipPath,
      String(configuration.blockedDestinations.length),
      ...configuration.blockedDestinations,
      configuration.bwrapPath,
      ...configuration.bwrapArgs,
      "--",
      command,
      ...commandArgs,
    ],
    {
      cwd: "/",
      env: process.env,
      stdio: [
        "inherit",
        "inherit",
        "inherit",
        configuration.passProjectFd ? 3 : "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const namespaceExited = childExit(namespaceProcess, "unshare failed");
  const gate = namespaceProcess.stdio[4];
  const pidStream = namespaceProcess.stdio[5];
  if (!gate || !pidStream) {
    throw new Error("Network namespace control pipes were not created");
  }

  let slirpProcess;
  const forwardSigint = () => namespaceProcess.kill("SIGINT");
  const forwardSigterm = () => namespaceProcess.kill("SIGTERM");
  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);

  try {
    const namespacePid = await readNamespacePid(pidStream, namespaceExited);
    slirpProcess = spawn(
      configuration.slirpPath,
      [
        "--configure",
        "--disable-host-loopback",
        "--enable-sandbox",
        "--enable-seccomp",
        "--ready-fd=3",
        "--exit-fd=4",
        String(namespacePid),
        "tap0",
      ],
      {
        cwd: "/",
        env: process.env,
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      },
    );
    let slirpStderr = "";
    slirpProcess.stderr.on("data", (chunk) => {
      if (slirpStderr.length < 8000) slirpStderr += chunk.toString("utf8");
    });
    const slirpExited = childExit(slirpProcess, "slirp4netns failed");
    const ready = slirpProcess.stdio[3];
    const exitGate = slirpProcess.stdio[4];
    if (!ready || !exitGate) {
      throw new Error("slirp4netns control pipes were not created");
    }
    await waitForReady(ready, slirpExited);
    ready.destroy();
    pidStream.destroy();
    gate.end("go\n");

    const outcome = await Promise.race([
      namespaceExited.then((result) => ({ owner: "namespace", result })),
      slirpExited.then((result) => ({ owner: "slirp", result })),
    ]);
    if (outcome.owner === "slirp") {
      namespaceProcess.kill("SIGTERM");
      throw new Error(
        `slirp4netns exited while the sandbox was running (${outcome.result.signal ? `signal ${outcome.result.signal}` : `status ${outcome.result.code}`})${slirpStderr.trim() ? `: ${slirpStderr.trim()}` : ""}`,
      );
    }

    exitGate.destroy();
    const slirpOutcome = await slirpExited;
    if (slirpOutcome.code !== 0) {
      throw new Error(
        `slirp4netns teardown failed (${slirpOutcome.signal ? `signal ${slirpOutcome.signal}` : `status ${slirpOutcome.code}`})${slirpStderr.trim() ? `: ${slirpStderr.trim()}` : ""}`,
      );
    }
    process.exitCode = outcome.result.signal
      ? exitCodeForSignal(outcome.result.signal)
      : (outcome.result.code ?? 1);
  } catch (error) {
    gate.destroy();
    namespaceProcess.kill("SIGTERM");
    slirpProcess?.kill("SIGTERM");
    throw error;
  } finally {
    process.off("SIGINT", forwardSigint);
    process.off("SIGTERM", forwardSigterm);
  }
}

main().catch((error) => {
  console.error(
    `[session-sandbox-network] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
