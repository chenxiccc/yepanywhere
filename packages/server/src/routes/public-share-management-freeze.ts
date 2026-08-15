import {
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
  type FreezePublicSharesResponse,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import {
  PublicShareCaptureError,
  type PublicShareRecord,
} from "../services/PublicShareService.js";
import {
  captureCompletePublicShare,
  type PublicShareRoutesDeps,
} from "./public-shares.js";

export type PublicShareManagementFreezeRoutesDeps = Pick<
  PublicShareRoutesDeps,
  "loadCompleteSession" | "publicShareService"
>;

interface FreezeSourceGroup {
  source: PublicShareRecord["source"];
  shareIds: Set<string>;
}

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function groupLiveSharesBySource(
  records: readonly PublicShareRecord[],
  requestedShareIds: ReadonlySet<string>,
): FreezeSourceGroup[] {
  const groups = new Map<string, FreezeSourceGroup>();
  for (const record of records) {
    if (record.mode !== "live" || !requestedShareIds.has(record.shareId)) {
      continue;
    }
    const key = `${record.source.projectId}\0${record.source.sessionId}`;
    let group = groups.get(key);
    if (!group) {
      group = { source: record.source, shareIds: new Set() };
      groups.set(key, group);
    }
    group.shareIds.add(record.shareId);
  }
  return [...groups.values()];
}

export function createPublicShareManagementFreezeRoutes(
  deps: PublicShareManagementFreezeRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.post("/public-shares/freeze-live", async (c) => {
    const readiness = deps.publicShareService.getReadiness();
    if (readiness.state !== "ready") {
      return c.json({ error: `Public share store is ${readiness.state}` }, 503);
    }

    let body: { confirmation?: unknown; shareIds?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.confirmation !== PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION) {
      return c.json(
        { error: "Explicit live-share freeze confirmation is required" },
        400,
      );
    }
    if (
      !Array.isArray(body.shareIds) ||
      body.shareIds.length === 0 ||
      !body.shareIds.every(
        (shareId) =>
          typeof shareId === "string" && SHARE_ID_PATTERN.test(shareId),
      )
    ) {
      return c.json({ error: "shareIds must contain valid share IDs" }, 400);
    }

    const requestedShareIds = new Set(body.shareIds);
    const groups = groupLiveSharesBySource(
      deps.publicShareService.getAllRecords(),
      requestedShareIds,
    );
    let convertedCount = 0;

    for (const group of groups) {
      try {
        const capture = await captureCompletePublicShare(
          deps,
          group.source.projectId,
          group.source.sessionId,
        );
        if (!capture) {
          return c.json(
            {
              error: "A source session was not found",
              convertedCount,
            },
            404,
          );
        }
        convertedCount += await deps.publicShareService.freezeLiveSharesById(
          group.shareIds,
          capture,
        );
      } catch (error) {
        if (error instanceof PublicShareCaptureError) {
          return c.json(
            {
              error: error.message,
              retryable: true,
              convertedCount,
            },
            409,
          );
        }
        throw error;
      }
    }

    const response: FreezePublicSharesResponse = {
      convertedCount,
      ...(deps.publicShareService.isCleanupPending()
        ? { cleanupPending: true }
        : {}),
    };
    return c.json(response);
  });

  return routes;
}
