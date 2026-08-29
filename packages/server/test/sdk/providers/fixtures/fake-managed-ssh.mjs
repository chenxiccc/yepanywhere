#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const separator = process.argv.indexOf("--", 2);
const hostIndex = separator === -1 ? process.argv.length - 2 : separator + 1;
const host = process.argv[hostIndex];
const command = process.argv[hostIndex + 1];

if (!host || !command) {
  process.stderr.write("fake managed SSH requires a host and command\n");
  process.exit(64);
}
if (process.env.YA_FAKE_SSH_RECORD) {
  appendFileSync(
    process.env.YA_FAKE_SSH_RECORD,
    `${JSON.stringify({
      args: process.argv.slice(2),
      host,
      command,
      sensitiveEnvironmentPresent: [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
      ].some((name) => process.env[name] !== undefined),
    })}\n`,
  );
}
if (process.env.YA_FAKE_SSH_PRECONNECT_FAILURE === "1") {
  process.stderr.write("fake SSH connection refused\n");
  process.exit(255);
}

const truncateInputAfter = Number(
  process.env.YA_FAKE_SSH_TRUNCATE_INPUT_AFTER_BYTES ?? 0,
);
const truncateInput =
  Number.isSafeInteger(truncateInputAfter) && truncateInputAfter > 0;
// Model a Linux target even when the test controller itself runs on Darwin.
const remoteArchitecture = process.arch === "arm64" ? "aarch64" : "x86_64";
const simulatedRemoteCommand = [
  "uname() {",
  `case "\${1-}" in`,
  "-s) printf '%s\\n' Linux ;;",
  `-m) printf '%s\\n' ${remoteArchitecture} ;;`,
  '*) command uname "$@" ;;',
  "esac",
  "}",
  ...(process.platform === "darwin"
    ? [
        "stat() {",
        `if [ "\${1-}" = "-c" ] && [ "\${2-}" = "%a" ] && [ "$#" -eq 3 ]; then`,
        'command stat -f "%Lp" "$3"',
        "else",
        'command stat "$@"',
        "fi",
        "}",
      ]
    : []),
  command,
].join("\n");
const child = spawn("/bin/sh", ["-c", simulatedRemoteCommand], {
  env: process.env,
  stdio: truncateInput ? ["pipe", "inherit", "inherit"] : "inherit",
});
if (truncateInput && child.stdin) {
  let forwarded = 0;
  process.stdin.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    if (forwarded >= truncateInputAfter) return;
    const remaining = truncateInputAfter - forwarded;
    const bounded = bytes.subarray(0, remaining);
    forwarded += bounded.byteLength;
    child.stdin.write(bounded);
    if (forwarded >= truncateInputAfter) child.stdin.end();
  });
  process.stdin.on("end", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  process.stdin.resume();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
const dropAfterMs = Number(process.env.YA_FAKE_SSH_DROP_AFTER_MS ?? 0);
if (Number.isFinite(dropAfterMs) && dropAfterMs > 0) {
  const timer = setTimeout(() => child.kill("SIGKILL"), dropAfterMs);
  timer.unref();
}
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 126;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
