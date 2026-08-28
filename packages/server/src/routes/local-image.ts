import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  createLocalResourcePathPolicy,
  LOCAL_MEDIA_CONTENT_TYPES,
} from "./local-resource-policy.js";
import {
  createMutableFileCacheMetadata,
  createNotModifiedResponse,
  isMutableFileNotModified,
  mutableFileCacheHeaders,
  type MutableFileOpener,
  openMutableFileSnapshot,
} from "./mutable-file-cache.js";
import { createUntrustedFileResponseHeaders } from "./untrusted-file-response.js";

interface LocalImageDeps {
  allowedPaths: string[] | (() => string[]);
  scanner?: Pick<ProjectScanner, "listProjects">;
  includeProjects?: () => boolean;
  openFile?: MutableFileOpener;
}

/**
 * Create routes for serving local images from allowed paths.
 *
 * Security: Only serves files that:
 * 1. Resolve (after symlink resolution) to a path under an allowed prefix
 * 2. Have a recognized image or video extension
 * 3. Are regular files (not directories, devices, etc.)
 */
export function createLocalImageRoutes(deps: LocalImageDeps) {
  const routes = new Hono();
  const pathPolicy = createLocalResourcePathPolicy(deps);

  routes.get("/", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    if (!pathPolicy.isAbsolutePath(filePath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = LOCAL_MEDIA_CONTENT_TYPES[ext];
    if (!contentType) {
      return c.json({ error: "Not a recognized media type" }, 400);
    }

    try {
      const resolved = await pathPolicy.resolveAllowedFilePath(filePath);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      const { resolvedPath } = resolved.file;
      const snapshot = await openMutableFileSnapshot(
        resolvedPath,
        deps.openFile,
      );
      if (!snapshot) {
        return c.json({ error: "Path is not a file" }, 400);
      }
      let fileHandle: FileHandle | undefined = snapshot.handle;
      const { stats } = snapshot;
      const cacheMetadata = createMutableFileCacheMetadata(stats);

      const headers = createUntrustedFileResponseHeaders({
        baseHeaders: {
          ...mutableFileCacheHeaders(cacheMetadata),
          "Content-Length": stats.size.toString(),
        },
        contentType,
        filePath: resolvedPath,
      });
      try {
        if (isMutableFileNotModified(c.req.raw.headers, cacheMetadata)) {
          return createNotModifiedResponse(headers);
        }
        const stream = fileHandle.createReadStream({
          autoClose: true,
          start: 0,
        });
        const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        const response = new Response(body, { headers });
        fileHandle = undefined;
        return response;
      } finally {
        await fileHandle?.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "File not found" }, 404);
      }
      console.error("[LocalImage] Error serving file:", err);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return routes;
}
