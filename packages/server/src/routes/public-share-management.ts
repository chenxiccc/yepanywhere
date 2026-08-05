import {
  type PublicShareManagementItem,
  type PublicSessionShareMode,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { PublicShareService } from "../services/PublicShareService.js";

export interface PublicShareManagementRoutesDeps {
  publicShareService: PublicShareService;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const REVOKE_ALL_CONFIRMATION = "revoke-all-public-shares";

interface ManagementCursor {
  createdAt: string;
  shareId: string;
}

function encodeCursor(item: ManagementCursor): string {
  return Buffer.from(
    JSON.stringify(["v1", item.createdAt, item.shareId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): ManagementCursor | null {
  if (!cursor) return { createdAt: "", shareId: "" };
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== "v1" ||
      typeof decoded[1] !== "string" ||
      typeof decoded[2] !== "string"
    ) {
      return null;
    }
    return { createdAt: decoded[1], shareId: decoded[2] };
  } catch {
    return null;
  }
}

function parsePageSize(value: string | undefined): number | null {
  if (!value) return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_PAGE_SIZE)
    : null;
}

export function createPublicShareManagementRoutes(
  deps: PublicShareManagementRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get("/public-shares", (c) => {
    const readiness = deps.publicShareService.getReadiness();
    if (readiness.state !== "ready") {
      c.header("Retry-After", "2");
      return c.json(
        {
          error: readiness.error ?? `Public share store is ${readiness.state}`,
          retryable:
            readiness.state === "opening" || readiness.state === "migrating",
          storageState: readiness.state,
        },
        503,
      );
    }
    const cursor = decodeCursor(c.req.query("cursor"));
    const limit = parsePageSize(c.req.query("limit"));
    if (cursor === null || limit === null) {
      return c.json(
        { error: "Invalid public share page cursor or limit" },
        400,
      );
    }
    const projectId = c.req.query("projectId");
    if (projectId && !isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    const sessionId = c.req.query("sessionId");
    const mode = c.req.query("mode") as PublicSessionShareMode | undefined;
    if (mode && mode !== "live" && mode !== "frozen") {
      return c.json({ error: "mode must be live or frozen" }, 400);
    }

    const records = deps.publicShareService
      .getAllRecords()
      .filter((record) => !projectId || record.source.projectId === projectId)
      .filter((record) => !sessionId || record.source.sessionId === sessionId)
      .filter((record) => !mode || record.mode === mode)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.shareId.localeCompare(a.shareId),
      );
    const start = cursor.createdAt
      ? records.findIndex(
          (record) =>
            record.createdAt < cursor.createdAt ||
            (record.createdAt === cursor.createdAt &&
              record.shareId < cursor.shareId),
        )
      : 0;
    const page = start < 0 ? [] : records.slice(start, start + limit);
    const items: PublicShareManagementItem[] = page.map((record) => ({
      shareId: record.shareId,
      url: record.publicUrl,
      mode: record.mode,
      title: record.title,
      projectName: record.source.projectName ?? null,
      sessionId: record.source.sessionId,
      provider: record.source.provider,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      capturedAt: record.capturedAt,
      linkedFileMode: record.linkedFileMode,
      snapshotBytes: record.snapshotBytes,
      activeViewerCount: deps.publicShareService.getActiveViewerCount(record),
      hasViewerSnapshots: Object.keys(record.viewerSnapshots ?? {}).length > 0,
    }));
    const last = page.at(-1);
    const hasMore = start >= 0 && start + page.length < records.length;
    return c.json({
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      totalCount: records.length,
    });
  });

  routes.delete("/public-shares/:shareId", async (c) => {
    const readiness = deps.publicShareService.getReadiness();
    if (readiness.state !== "ready") {
      return c.json({ error: `Public share store is ${readiness.state}` }, 503);
    }
    const revoked = await deps.publicShareService.revokeShare(
      c.req.param("shareId"),
    );
    return c.json({
      revoked,
      ...(deps.publicShareService.isCleanupPending()
        ? { cleanupPending: true }
        : {}),
    });
  });

  routes.post("/public-shares/revoke-all", async (c) => {
    const readiness = deps.publicShareService.getReadiness();
    if (readiness.state !== "ready") {
      return c.json({ error: `Public share store is ${readiness.state}` }, 503);
    }
    let body: { confirmation?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.confirmation !== REVOKE_ALL_CONFIRMATION) {
      return c.json(
        { error: "Explicit revoke-all confirmation is required" },
        400,
      );
    }
    const revokedCount = await deps.publicShareService.revokeAllShares();
    return c.json({
      revokedCount,
      ...(deps.publicShareService.isCleanupPending()
        ? { cleanupPending: true }
        : {}),
    });
  });

  return routes;
}
