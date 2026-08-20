import { existsSync } from "node:fs";
import { win32 as windowsPath } from "node:path";
import { parseCommandLookupOutput } from "../cli-detection.js";

const PI_PACKAGE_ENTRY = [
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
] as const;

/** A directly spawnable Pi process plus arguments required before Pi flags. */
export interface PiLaunchTarget {
  command: string;
  argsPrefix: string[];
  /** The configured or discovered path that selected this target. */
  sourcePath: string;
}

function nodeEntrypointTarget(
  sourcePath: string,
  entrypoint: string,
  nodeExecutable: string,
): PiLaunchTarget {
  return {
    command: nodeExecutable,
    argsPrefix: [entrypoint],
    sourcePath,
  };
}

/**
 * Turn one existing Pi path into a target Node can spawn without a shell.
 *
 * npm's Windows shims are not executable through `execFile()` / `spawn()`.
 * Resolve the package's declared JavaScript bin instead. The two candidates
 * cover global npm prefixes (`<prefix>/pi.cmd` beside `node_modules`) and
 * project-local bins (`node_modules/.bin/pi.cmd` beside the scoped package).
 */
export function resolvePiLaunchTarget(
  sourcePath: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  nodeExecutable: string = process.execPath,
): PiLaunchTarget | null {
  if (!fileExists(sourcePath)) return null;

  if (platform !== "win32") {
    return { command: sourcePath, argsPrefix: [], sourcePath };
  }

  if (/\.(?:exe|com)$/i.test(sourcePath)) {
    return { command: sourcePath, argsPrefix: [], sourcePath };
  }

  if (/\.[cm]?js$/i.test(sourcePath)) {
    return nodeEntrypointTarget(sourcePath, sourcePath, nodeExecutable);
  }

  const shimDirectory = windowsPath.dirname(sourcePath);
  const entrypoints = [
    windowsPath.join(shimDirectory, "node_modules", ...PI_PACKAGE_ENTRY),
  ];
  if (windowsPath.basename(shimDirectory).toLowerCase() === ".bin") {
    entrypoints.push(
      windowsPath.join(shimDirectory, "..", ...PI_PACKAGE_ENTRY),
    );
  }

  const entrypoint = entrypoints.find((path) => fileExists(path));
  return entrypoint
    ? nodeEntrypointTarget(sourcePath, entrypoint, nodeExecutable)
    : null;
}

/** Select the first safely launchable Pi candidate from `which` / `where`. */
export function selectPiLaunchTarget(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  nodeExecutable: string = process.execPath,
): PiLaunchTarget | null {
  const candidates = parseCommandLookupOutput(stdout).filter((path) =>
    fileExists(path),
  );

  if (platform === "win32") {
    const native = candidates.find((path) => /\.(?:exe|com)$/i.test(path));
    if (native) {
      return resolvePiLaunchTarget(
        native,
        platform,
        fileExists,
        nodeExecutable,
      );
    }
  }

  for (const candidate of candidates) {
    const target = resolvePiLaunchTarget(
      candidate,
      platform,
      fileExists,
      nodeExecutable,
    );
    if (target) return target;
  }
  return null;
}

export function buildPiLaunchArgs(
  target: PiLaunchTarget,
  args: readonly string[],
): string[] {
  return [...target.argsPrefix, ...args];
}
