import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type UploadClientMessage,
  type UploadCompleteMessage,
  type UploadErrorMessage,
  type UploadProgressMessage,
  type UploadServerMessage,
  type StagedAttachmentRef,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { WSContext, WSEvents } from "hono/ws";
import type { ProjectScanner } from "../projects/scanner.js";
import { getDataDir } from "../config.js";
import { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import {
  type AttachmentStagingService,
  UploadManager,
  getLegacyProjectAttachmentDir,
  isSafeUploadPathSegment,
  resolveUploadStoragePath,
} from "../uploads/index.js";

/** Progress update interval in bytes (64KB) */
const PROGRESS_INTERVAL_BYTES = 64 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface UploadDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
  /** Maximum upload file size in bytes. 0 = unlimited */
  maxUploadSizeBytes?: number;
  attachmentStagingService?: AttachmentStagingService;
  storagePolicy?: ProjectStoragePolicy;
}

interface DraftAttachmentRefsBody {
  refs?: StagedAttachmentRef[];
}

interface MaterializeDraftAttachmentsBody extends DraftAttachmentRefsBody {
  batchId?: string;
}

function stagingRouteErrorStatus(error: unknown): 400 | 404 | 409 | 500 {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Invalid ")) return 400;
  if (message.includes("not found")) return 404;
  if (message.includes("missing or invalid")) return 409;
  if (message.includes("unexpected size")) return 409;
  return 500;
}

function stagingRouteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Attachment staging failed";
}

function uploadErrorCode(error: unknown, fallback: string): string {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    return "DISK_FULL";
  }
  return fallback;
}

function isStagedAttachmentRefArray(
  value: unknown,
): value is StagedAttachmentRef[] {
  return Array.isArray(value);
}

/**
 * Look for a UUID-prefixed attachment filename in every session subdirectory
 * of the given attachment roots, skipping the directory already probed.
 */
async function findFilenameInSessionDirs(
  roots: readonly string[],
  filename: string,
  probedSessionId: string,
): Promise<{ path: string; size: number } | null> {
  for (const root of roots) {
    let subdirs: string[];
    try {
      subdirs = await readdir(root);
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      if (subdir === probedSessionId) continue;
      const candidate = join(root, subdir, filename);
      const stats = await stat(candidate).catch(() => null);
      if (stats?.isFile()) {
        return { path: candidate, size: stats.size };
      }
    }
  }
  return null;
}

export function createUploadRoutes(deps: UploadDeps): Hono {
  const routes = new Hono();
  const storagePolicy =
    deps.storagePolicy ??
    new ProjectStoragePolicy({
      dataDir: getDataDir(),
      getMode: () => "app-data",
    });
  const uploadManager = new UploadManager({
    maxUploadSizeBytes: deps.maxUploadSizeBytes,
    storagePolicy,
  });

  const sendMessage = (ws: WSContext, msg: UploadServerMessage) => {
    ws.send(JSON.stringify(msg));
  };

  const sendError = (ws: WSContext, message: string, code?: string) => {
    const errorMsg: UploadErrorMessage = { type: "error", message, code };
    sendMessage(ws, errorMsg);
  };

  interface UploadWebSocketBackend {
    startUpload(
      msg: UploadClientMessage & { type: "start" },
    ): Promise<{ uploadId: string }>;
    writeChunk(uploadId: string, chunk: Buffer): Promise<number>;
    completeUpload(uploadId: string): Promise<UploadCompleteMessage>;
    cancelUpload(uploadId: string): Promise<void>;
  }

  const createUploadWebSocketEvents = (
    validate: () => Promise<boolean>,
    validationFailedMessage: string,
    backend: UploadWebSocketBackend,
  ): WSEvents => {
    // Track current upload for this connection
    let currentUploadId: string | null = null;
    let lastProgressSent = 0;

    // Validation promise - we need to await this before processing messages
    // because onOpen can be async but @hono/node-ws doesn't wait for it
    let validationPromise: Promise<boolean> | null = null;
    let validationResult: boolean | null = null;

    // Message queue to serialize async message handling
    // This prevents race conditions where binary chunks arrive before
    // the async startUpload() completes
    let messageQueue: Promise<void> = Promise.resolve();

    // Process a single message - must be called sequentially via the queue
    const processMessage = async (
      data: string | ArrayBuffer | SharedArrayBuffer | Buffer | Blob,
      ws: WSContext,
    ): Promise<void> => {
      // Wait for validation to complete if it hasn't yet
      if (validationResult === null && validationPromise) {
        validationResult = await validationPromise;
      }

      if (!validationResult) {
        sendError(ws, "Connection not validated", "NOT_VALIDATED");
        return;
      }

      // When using the unified upgrade handler with wss.handleUpgrade,
      // the 'ws' library delivers ALL messages as Buffer by default,
      // bypassing @hono/node-ws's text/binary conversion.
      // We need to handle both Buffer and string data types.

      // Convert Buffer/ArrayBuffer to string for potential JSON parsing
      let stringData: string | null = null;
      let bufferData: Buffer | null = null;

      if (typeof data === "string") {
        stringData = data;
      } else if (
        data instanceof ArrayBuffer ||
        data instanceof SharedArrayBuffer ||
        Buffer.isBuffer(data)
      ) {
        bufferData = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        // Try to interpret as UTF-8 string for JSON control messages
        stringData = bufferData.toString("utf8");
      } else if (data instanceof Blob) {
        // Blob handling (rare in Node.js WebSocket but possible)
        const arrayBuffer = await data.arrayBuffer();
        bufferData = Buffer.from(arrayBuffer);
        stringData = bufferData.toString("utf8");
      }

      // Try to parse as JSON control message first
      let msg: UploadClientMessage | null = null;
      if (stringData) {
        const trimmed = stringData.trim();
        if (trimmed.startsWith("{")) {
          try {
            msg = JSON.parse(trimmed) as UploadClientMessage;
          } catch {
            // Not valid JSON - treat as binary data
            msg = null;
          }
        }
      }

      // If we parsed a control message, handle it
      if (msg !== null) {
        switch (msg.type) {
          case "start": {
            // Clean up any previous upload
            if (currentUploadId) {
              await backend.cancelUpload(currentUploadId);
            }

            try {
              const { uploadId } = await backend.startUpload(msg);
              currentUploadId = uploadId;
              lastProgressSent = 0;
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to start upload";
              sendError(ws, message, uploadErrorCode(err, "START_ERROR"));
            }
            break;
          }

          case "end": {
            if (!currentUploadId) {
              sendError(ws, "No upload in progress", "NO_UPLOAD");
              return;
            }

            const uploadId = currentUploadId;
            try {
              const complete = await backend.completeUpload(uploadId);
              sendMessage(ws, complete);
              currentUploadId = null;
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : "Failed to complete upload";
              sendError(ws, message, uploadErrorCode(err, "COMPLETE_ERROR"));
              await backend.cancelUpload(uploadId);
              currentUploadId = null;
            }
            break;
          }

          case "cancel": {
            if (currentUploadId) {
              await backend.cancelUpload(currentUploadId);
              currentUploadId = null;
            }
            break;
          }
        }
        return;
      }

      // Otherwise, treat as binary chunk data
      if (!currentUploadId) {
        sendError(
          ws,
          "No upload started - send start message first",
          "NO_UPLOAD",
        );
        return;
      }

      const uploadId = currentUploadId;
      try {
        // Convert to Buffer if needed (bufferData should already be set at this point)
        const chunk =
          bufferData ?? (typeof data === "string" ? Buffer.from(data) : null);
        if (!chunk) {
          sendError(ws, "Invalid chunk data", "INVALID_CHUNK");
          return;
        }

        const bytesReceived = await backend.writeChunk(uploadId, chunk);

        // Send progress updates periodically
        if (bytesReceived - lastProgressSent >= PROGRESS_INTERVAL_BYTES) {
          const progress: UploadProgressMessage = {
            type: "progress",
            bytesReceived,
          };
          sendMessage(ws, progress);
          lastProgressSent = bytesReceived;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Write failed";
        sendError(ws, message, uploadErrorCode(err, "WRITE_ERROR"));
        await backend.cancelUpload(uploadId);
        currentUploadId = null;
      }
    };

    return {
      onOpen(_evt, ws) {
        // Start validation (don't await - @hono/node-ws doesn't support async onOpen)
        validationPromise = validate();
        validationPromise.then((result) => {
          validationResult = result;
          if (!result) {
            sendError(ws, validationFailedMessage, "VALIDATION_FAILED");
            ws.close(1008, "Validation failed");
          }
        });
      },

      onMessage(evt, ws) {
        // Queue this message to be processed after all previous messages complete
        // This serializes async processing and prevents race conditions
        messageQueue = messageQueue.then(() =>
          processMessage(evt.data, ws).catch((err) => {
            console.error("[Upload WS] Unexpected error:", err);
            sendError(ws, "Internal error", "INTERNAL_ERROR");
          }),
        );
      },

      async onClose(_evt, _ws) {
        // Wait for any pending messages to complete
        await messageQueue;
        // Clean up partial uploads on disconnect
        if (currentUploadId) {
          await backend.cancelUpload(currentUploadId);
        }
      },

      onError(_evt, _ws) {
        // Clean up on error
        if (currentUploadId) {
          backend.cancelUpload(currentUploadId).catch(() => {});
        }
      },
    };
  };

  // WebSocket endpoint: /projects/:projectId/sessions/:sessionId/upload/ws
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/ws",
    deps.upgradeWebSocket((c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      let projectPath: string | null = null;

      const validate = async (): Promise<boolean> => {
        // Validate projectId format
        if (!isUrlProjectId(projectId)) {
          return false;
        }

        // Validate project exists, including first-time directories that have
        // not produced provider session files yet.
        const project = await deps.scanner.getOrCreateProject(projectId);
        if (!project) {
          return false;
        }
        projectPath = project.path;

        return true;
      };

      return createUploadWebSocketEvents(
        validate,
        "Project validation failed",
        {
          startUpload: async (msg) => {
            const { uploadId } = await uploadManager.startUpload(
              projectId,
              sessionId,
              msg.name,
              msg.size,
              msg.mimeType,
              projectPath ?? undefined,
              msg.width !== undefined && msg.height !== undefined
                ? { width: msg.width, height: msg.height }
                : undefined,
            );
            return { uploadId };
          },
          writeChunk: (uploadId, chunk) =>
            uploadManager.writeChunk(uploadId, chunk),
          completeUpload: async (uploadId) => {
            const file = await uploadManager.completeUpload(uploadId);
            return { type: "complete", file };
          },
          cancelUpload: (uploadId) => uploadManager.cancelUpload(uploadId),
        },
      );
    }),
  );

  // WebSocket endpoint: /attachments/staging/drafts/upload/ws
  routes.get(
    "/attachments/staging/drafts/upload/ws",
    deps.upgradeWebSocket(() =>
      createUploadWebSocketEvents(
        async () => deps.attachmentStagingService !== undefined,
        "Attachment staging is unavailable",
        {
          startUpload: async (msg) => {
            if (!deps.attachmentStagingService) {
              throw new Error("Attachment staging is unavailable");
            }
            return deps.attachmentStagingService.startDraftUpload({
              batchId: msg.batchId,
              originalName: msg.name,
              size: msg.size,
              mimeType: msg.mimeType,
              ...(msg.width !== undefined ? { width: msg.width } : {}),
              ...(msg.height !== undefined ? { height: msg.height } : {}),
            });
          },
          writeChunk: (uploadId, chunk) => {
            if (!deps.attachmentStagingService) {
              throw new Error("Attachment staging is unavailable");
            }
            return deps.attachmentStagingService.writeChunk(uploadId, chunk);
          },
          completeUpload: async (uploadId) => {
            if (!deps.attachmentStagingService) {
              throw new Error("Attachment staging is unavailable");
            }
            const stagedRef =
              await deps.attachmentStagingService.completeUpload(uploadId);
            return {
              type: "complete",
              stagedRef,
              batchId: stagedRef.batchId,
            };
          },
          cancelUpload: (uploadId) => {
            if (!deps.attachmentStagingService) {
              return Promise.resolve();
            }
            return deps.attachmentStagingService.cancelUpload(uploadId);
          },
        },
      ),
    ),
  );

  // POST endpoint: /attachments/staging/drafts/:batchId/validate
  routes.post("/attachments/staging/drafts/:batchId/validate", async (c) => {
    if (!deps.attachmentStagingService) {
      return c.json({ error: "Attachment staging is unavailable" }, 404);
    }

    let body: DraftAttachmentRefsBody;
    try {
      body = await c.req.json<DraftAttachmentRefsBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!isStagedAttachmentRefArray(body.refs)) {
      return c.json({ error: "refs must be an array" }, 400);
    }

    try {
      const refs = await deps.attachmentStagingService.validateDraftRefs(
        c.req.param("batchId"),
        body.refs,
      );
      return c.json({ refs });
    } catch (error) {
      return c.json(
        { error: stagingRouteErrorMessage(error) },
        stagingRouteErrorStatus(error),
      );
    }
  });

  // DELETE endpoint: /attachments/staging/drafts/:batchId/:attachmentId
  routes.delete(
    "/attachments/staging/drafts/:batchId/:attachmentId",
    async (c) => {
      if (!deps.attachmentStagingService) {
        return c.json({ error: "Attachment staging is unavailable" }, 404);
      }

      try {
        const deleted =
          await deps.attachmentStagingService.deleteDraftAttachment(
            c.req.param("batchId"),
            c.req.param("attachmentId"),
          );
        if (!deleted) {
          return c.json({ error: "Staged attachment not found" }, 404);
        }
        return c.json({ deleted });
      } catch (error) {
        return c.json(
          { error: stagingRouteErrorMessage(error) },
          stagingRouteErrorStatus(error),
        );
      }
    },
  );

  // POST endpoint: /projects/:projectId/sessions/:sessionId/attachments/staging/materialize
  routes.post(
    "/projects/:projectId/sessions/:sessionId/attachments/staging/materialize",
    async (c) => {
      if (!deps.attachmentStagingService) {
        return c.json({ error: "Attachment staging is unavailable" }, 404);
      }

      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID" }, 400);
      }

      let body: MaterializeDraftAttachmentsBody;
      try {
        body = await c.req.json<MaterializeDraftAttachmentsBody>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (!body.batchId) {
        return c.json({ error: "batchId is required" }, 400);
      }
      if (!isStagedAttachmentRefArray(body.refs)) {
        return c.json({ error: "refs must be an array" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Unknown project" }, 404);
      }

      try {
        const files =
          await deps.attachmentStagingService.materializeDraftAttachmentsForSession(
            {
              batchId: body.batchId,
              refs: body.refs,
              projectPath: project.path,
              sessionId,
            },
          );
        return c.json({ files });
      } catch (error) {
        return c.json(
          { error: stagingRouteErrorMessage(error) },
          stagingRouteErrorStatus(error),
        );
      }
    },
  );

  // GET endpoint: /projects/:projectId/sessions/:sessionId/upload/:filename
  // Serves uploaded files for viewing in the client
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/:filename",
    async (c) => {
      const projectId = c.req.param("projectId") as string;
      const sessionId = c.req.param("sessionId") as string;
      const filename = c.req.param("filename") as string;

      // Validate projectId format
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID" }, 400);
      }

      // Validate filename - must have UUID prefix format
      if (
        !filename ||
        !/^[0-9a-f-]{36}_/.test(filename) ||
        !isSafeUploadPathSegment(filename)
      ) {
        return c.json({ error: "Invalid filename" }, 400);
      }

      const project = await deps.scanner.getOrCreateProject(projectId);
      if (!project) {
        return c.json({ error: "Unknown project" }, 404);
      }

      const policyFilePaths = storagePolicy.readPaths(
        project.path,
        "attachments",
        sessionId,
        filename,
      );
      const legacyProjectFilePath = join(
        getLegacyProjectAttachmentDir(project.path, sessionId),
        filename,
      );
      const legacyFilePath = resolveUploadStoragePath(
        join(storagePolicy.dataDir, "uploads"),
        projectId,
        sessionId,
        filename,
      );

      try {
        const candidates = [
          ...policyFilePaths,
          legacyProjectFilePath,
          legacyFilePath,
        ].filter((candidate): candidate is string => Boolean(candidate));

        let found: { path: string; size: number } | null = null;
        for (const candidate of candidates) {
          const stats = await stat(candidate).catch((err) => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              return null;
            }
            throw err;
          });
          if (stats?.isFile()) {
            found = { path: candidate, size: stats.size };
            break;
          }
        }

        // The URL's session id is the logical session the client is viewing,
        // but files are materialized under the session id known at upload
        // time: a provisional id for a brand-new session's first turn, or a
        // prior resume-generation id. The UUID-prefixed filename is globally
        // unique, so fall back to the sibling session directories of each
        // storage root. See topics/attachment-storage.md.
        if (!found) {
          const attachmentRoots = [
            ...storagePolicy.readPaths(project.path, "attachments"),
            join(project.path, ".attachments"),
            join(storagePolicy.dataDir, "uploads", projectId),
          ];
          found = await findFilenameInSessionDirs(
            attachmentRoots,
            filename,
            sessionId,
          );
        }

        if (!found) {
          return c.json({ error: "File not found" }, 404);
        }
        const foundPath = found.path;

        // Determine content type from filename extension
        const ext = filename.split(".").pop()?.toLowerCase() ?? "";
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
          pdf: "application/pdf",
          txt: "text/plain",
          json: "application/json",
        };
        const contentType = mimeTypes[ext] ?? "application/octet-stream";

        c.header("Content-Type", contentType);
        c.header("Content-Length", found.size.toString());
        c.header("Cache-Control", "private, max-age=3600");

        return stream(c, async (s) => {
          const readable = createReadStream(foundPath);
          for await (const chunk of readable) {
            await s.write(chunk);
          }
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "File not found" }, 404);
        }
        console.error("[Upload] Error serving file:", err);
        return c.json({ error: "Internal error" }, 500);
      }
    },
  );

  return routes;
}
