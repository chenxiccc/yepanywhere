#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const logDir = process.env.RUNNER_TEMP || tmpdir();
const log = createWriteStream(join(logDir, "yep-tauri-build.log"), {
  flags: "a",
});
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) {
  throw new Error("npm_execpath is required to run the CI Tauri wrapper");
}
const child = spawn(
  process.execPath,
  [pnpmEntry, "tauri", ...process.argv.slice(2)],
  {
    stdio: ["inherit", "pipe", "pipe"],
  },
);

child.stdout.pipe(process.stdout);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(process.stderr);
child.stderr.pipe(log, { end: false });

function waitForChild(childProcess, label) {
  return new Promise((resolveExit, rejectExit) => {
    childProcess.once("error", rejectExit);
    childProcess.once("close", (code, signal) => {
      if (signal) {
        rejectExit(new Error(`${label} terminated by ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

let exitCode = await waitForChild(child, "Tauri build");

if (exitCode === 0 && process.platform === "darwin") {
  const targetTriple = process.env.TARGET_TRIPLE?.trim();
  if (!targetTriple) {
    throw new Error("TARGET_TRIPLE is required for the signed macOS smoke");
  }
  const appBundle = join(
    desktopDir,
    "src-tauri",
    "target",
    targetTriple,
    "release",
    "bundle",
    "macos",
    "YepAnywhere.app",
  );
  if (!existsSync(appBundle)) {
    throw new Error(`Built macOS app not found at ${appBundle}`);
  }

  const smoke = spawn(
    process.execPath,
    [join(desktopDir, "scripts", "smoke-runtime.mjs")],
    {
      env: {
        ...process.env,
        YEP_DESKTOP_APP_BUNDLE: appBundle,
        YEP_DESKTOP_REQUIRE_ALLOW_JIT:
          process.env.HAS_MACOS_SIGNING === "true" ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  smoke.stdout.pipe(process.stdout);
  smoke.stdout.pipe(log, { end: false });
  smoke.stderr.pipe(process.stderr);
  smoke.stderr.pipe(log, { end: false });
  exitCode = await waitForChild(smoke, "Signed macOS runtime smoke");
}

await new Promise((resolveLog, rejectLog) => {
  log.end((error) => {
    if (error) {
      rejectLog(error);
      return;
    }
    resolveLog();
  });
});

process.exitCode = exitCode;
