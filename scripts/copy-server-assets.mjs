#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(rootDir, "packages/server/src/services/voice");
const targetDir = join(rootDir, "packages/server/dist/services/voice");
const serverSourceDir = join(rootDir, "packages/server/src");
const serverTargetDir = join(rootDir, "packages/server/dist");

mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith("_worker.py")) {
    continue;
  }
  const source = join(sourceDir, entry.name);
  const target = join(targetDir, entry.name);
  copyFileSync(source, target);
  copied += 1;
}

if (copied === 0) {
  throw new Error(
    `No server worker assets copied from ${relative(rootDir, sourceDir)}`,
  );
}

for (const expected of [
  "whisper_worker.py",
  "parakeet_worker.py",
  "nemo_worker.py",
]) {
  if (!existsSync(join(targetDir, expected))) {
    throw new Error(`Expected ${expected} in server dist assets`);
  }
}

copyFileSync(
  join(serverSourceDir, "session-sandbox-network-launcher.mjs"),
  join(serverTargetDir, "session-sandbox-network-launcher.mjs"),
);
