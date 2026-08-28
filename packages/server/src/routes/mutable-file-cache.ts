import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

export const MUTABLE_FILE_CACHE_CONTROL = "private, no-cache";

type MutableFileStats = Pick<Stats, "ctimeMs" | "mtimeMs" | "size">;

export type MutableFileOpener = (filePath: string) => Promise<FileHandle>;

export interface MutableFileSnapshot {
  handle: FileHandle;
  stats: Stats;
}

/** Open and validate the same descriptor that will supply response bytes. */
export async function openMutableFileSnapshot(
  filePath: string,
  openFile: MutableFileOpener = (path) => open(path, "r"),
): Promise<MutableFileSnapshot | null> {
  const handle = await openFile(filePath);
  let retained = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    retained = true;
    return { handle, stats };
  } finally {
    if (!retained) await handle.close();
  }
}

export interface MutableFileCacheMetadata {
  etag: string;
  lastModified: string;
  modifiedAtSeconds: number;
}

function validatorTimePart(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "0";
  return Math.trunc(milliseconds * 1_000).toString(16);
}

/**
 * Build a cheap weak validator for a mutable filesystem path. Size and mtime
 * cover ordinary writes; ctime also invalidates same-size replacements whose
 * mtime was deliberately preserved.
 */
export function createMutableFileCacheMetadata(
  stats: MutableFileStats,
): MutableFileCacheMetadata {
  const modifiedAtSeconds = Math.floor(stats.mtimeMs / 1_000);
  return {
    etag: `W/"${stats.size.toString(16)}-${validatorTimePart(stats.mtimeMs)}-${validatorTimePart(stats.ctimeMs)}"`,
    lastModified: new Date(modifiedAtSeconds * 1_000).toUTCString(),
    modifiedAtSeconds,
  };
}

export function mutableFileCacheHeaders(
  metadata: MutableFileCacheMetadata,
): Record<string, string> {
  return {
    "Cache-Control": MUTABLE_FILE_CACHE_CONTROL,
    ETag: metadata.etag,
    "Last-Modified": metadata.lastModified,
  };
}

function normalizeWeakEntityTag(value: string): string {
  return value.trim().replace(/^W\//i, "");
}

function ifNoneMatchMatches(value: string, etag: string): boolean {
  const normalizedCurrent = normalizeWeakEntityTag(etag);
  return value.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return (
      trimmed === "*" || normalizeWeakEntityTag(trimmed) === normalizedCurrent
    );
  });
}

/** Apply conditional-GET precedence for a mutable file representation. */
export function isMutableFileNotModified(
  requestHeaders: Headers,
  metadata: MutableFileCacheMetadata,
): boolean {
  const ifNoneMatch = requestHeaders.get("If-None-Match");
  if (ifNoneMatch !== null) {
    return ifNoneMatchMatches(ifNoneMatch, metadata.etag);
  }

  const ifModifiedSince = requestHeaders.get("If-Modified-Since");
  if (ifModifiedSince === null) return false;
  const sinceMs = Date.parse(ifModifiedSince);
  if (!Number.isFinite(sinceMs)) return false;
  return metadata.modifiedAtSeconds * 1_000 <= sinceMs;
}

export function createNotModifiedResponse(headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.delete("Content-Length");
  return new Response(null, { headers: responseHeaders, status: 304 });
}
