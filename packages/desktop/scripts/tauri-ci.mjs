#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = process.env.RUNNER_TEMP || tmpdir();
const log = createWriteStream(join(logDir, "yep-tauri-build.log"), {
  flags: "a",
});
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

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (signal) {
      reject(new Error(`Tauri build terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

await new Promise((resolve, reject) => {
  log.end((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

process.exitCode = exitCode;
