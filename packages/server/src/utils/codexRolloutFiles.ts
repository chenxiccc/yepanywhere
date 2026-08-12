import * as path from "node:path";

export type CodexRolloutRepresentation = "plain" | "zstd";

export interface CodexRolloutDiscoveryIdentity {
  key: string;
  shardKey: string;
  relativePath: string;
  canonicalRelativePath: string;
  representation: CodexRolloutRepresentation;
}

export function isCodexRolloutFileName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
}

export function getCodexRolloutSessionId(nameOrPath: string): string | null {
  const fileName = path.posix.basename(nameOrPath.replace(/\\/g, "/"));
  if (!fileName.startsWith("rollout-")) return null;
  const match = fileName.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i,
  );
  return match?.[1] ?? null;
}

export function isCompressedCodexRolloutPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl.zst");
}

export function plainCodexRolloutPath(filePath: string): string {
  return isCompressedCodexRolloutPath(filePath)
    ? filePath.slice(0, -".zst".length)
    : filePath;
}

export function preferPlainCodexRollouts(filePaths: string[]): string[] {
  const plainPaths = new Set(
    filePaths
      .filter((filePath) => filePath.endsWith(".jsonl"))
      .map((filePath) => filePath),
  );

  return filePaths.filter((filePath) => {
    if (!isCompressedCodexRolloutPath(filePath)) return true;
    return !plainPaths.has(plainCodexRolloutPath(filePath));
  });
}

export function codexRolloutRepresentation(
  filePath: string,
): CodexRolloutRepresentation {
  return isCompressedCodexRolloutPath(filePath) ? "zstd" : "plain";
}

/**
 * Windows can defer a file's last-write timestamp until every write handle is
 * closed. Codex keeps plain rollout files open for the lifetime of a session,
 * while Windows change time advances on each append. Keep mtime authoritative
 * everywhere else, including immutable compressed rollouts.
 */
export function getCodexRolloutActivityTimeMs(
  filePath: string,
  stats: { mtimeMs: number | bigint; ctimeMs: number | bigint },
  platform: NodeJS.Platform = process.platform,
): number {
  const mtimeMs = Number(stats.mtimeMs);
  if (platform !== "win32" || isCompressedCodexRolloutPath(filePath)) {
    return mtimeMs;
  }

  const ctimeMs = Number(stats.ctimeMs);
  return Number.isFinite(ctimeMs) ? Math.max(mtimeMs, ctimeMs) : mtimeMs;
}

export function getCodexRolloutDiscoveryIdentity(
  sessionsDir: string,
  filePath: string,
): CodexRolloutDiscoveryIdentity {
  const relativePath = path.relative(sessionsDir, filePath).replace(/\\/g, "/");
  const canonicalRelativePath = plainCodexRolloutPath(relativePath);
  const shardDir = path.posix.dirname(canonicalRelativePath);
  return {
    key: path.posix.basename(canonicalRelativePath),
    shardKey: shardDir === "." ? "_root" : shardDir,
    relativePath,
    canonicalRelativePath,
    representation: codexRolloutRepresentation(filePath),
  };
}
