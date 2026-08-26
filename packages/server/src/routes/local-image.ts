import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { stream } from "hono/streaming";
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
} from "./mutable-file-cache.js";
import { createUntrustedFileResponseHeaders } from "./untrusted-file-response.js";

interface LocalImageDeps {
  allowedPaths: string[] | (() => string[]);
  scanner?: Pick<ProjectScanner, "listProjects">;
  includeProjects?: () => boolean;
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
      const { resolvedPath, stats } = resolved.file;
      const cacheMetadata = createMutableFileCacheMetadata(stats);

      const headers = createUntrustedFileResponseHeaders({
        baseHeaders: {
          ...mutableFileCacheHeaders(cacheMetadata),
          "Content-Length": stats.size.toString(),
        },
        contentType,
        filePath: resolvedPath,
      });
      if (isMutableFileNotModified(c.req.raw.headers, cacheMetadata)) {
        return createNotModifiedResponse(headers);
      }
      headers.forEach((value, name) => {
        c.header(name, value);
      });

      return stream(c, async (s) => {
        const readable = createReadStream(resolvedPath);
        for await (const chunk of readable) {
          await s.write(chunk);
        }
      });
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
