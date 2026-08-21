export interface NpmCommandTarget {
  command: string;
  argsPrefix: string[];
}

/**
 * Resolve npm through a directly executable command on every supported OS.
 *
 * Windows npm installations expose `npm.cmd`, which Node cannot execute with
 * `execFile()` directly. Use the native command interpreter with fixed control
 * flags, then append only caller-owned argument-vector entries.
 */
export function resolveNpmCommandTarget(
  platform: NodeJS.Platform = process.platform,
): NpmCommandTarget {
  return platform === "win32"
    ? {
        command: "cmd.exe",
        argsPrefix: ["/d", "/s", "/c", "npm.cmd"],
      }
    : { command: "npm", argsPrefix: [] };
}

export function buildNpmCommandArgs(
  target: NpmCommandTarget,
  args: readonly string[],
): string[] {
  return [...target.argsPrefix, ...args];
}
