import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { platform } from "node:process";

let ensured = false;

function getNodePtyRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const nodePtyPackageJson = require.resolve("node-pty/package.json");
    return path.dirname(nodePtyPackageJson);
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable(): void {
  if (platform !== "darwin" || ensured) {
    return;
  }

  ensured = true;

  const nodePtyRoot = getNodePtyRoot();
  if (!nodePtyRoot) {
    return;
  }

  const helperDirs = ["darwin-arm64", "darwin-x64"];

  for (const helperDir of helperDirs) {
    const helperPath = path.join(nodePtyRoot, "prebuilds", helperDir, "spawn-helper");
    if (!existsSync(helperPath)) {
      continue;
    }

    try {
      chmodSync(helperPath, 0o755);
    } catch {
      // Ignore permission repair failures here and let node-pty surface the real spawn error.
    }
  }
}

export function hasExecutableShell(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
