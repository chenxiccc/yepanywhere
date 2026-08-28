import {
  DEFAULT_RELAY_URL,
  isUrlProjectId,
  normalizeRelayUrl,
  type CreatePublicFileShareRequest,
  type CreatePublicFileShareResponse,
  type PublicFileShareListResponse,
  type RevokePublicShareResponse,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { decodeProjectId } from "../projects/paths.js";
import type { PublicShareService } from "../services/PublicShareService.js";
import {
  buildPublicShareViewerUrl,
  resolveYaClientBaseUrl,
} from "../utils/publicShareViewerUrl.js";
import {
  normalizePublicShareProjectFilePath,
  type RelayConfigForPublicShare,
} from "./public-shares.js";

export interface PublicFileShareRoutesDeps {
  publicShareService: PublicShareService;
  fetchProjectFile?: (
    projectId: UrlProjectId,
    path: string,
    options: { raw?: boolean },
  ) => Promise<Response>;
  getPublicSharesEnabled?: () => boolean;
  getRemoteAccessEnabled?: () => boolean;
  getRelayConfig?: () => RelayConfigForPublicShare | null;
  getYaClientBaseUrl?: () => string | null | undefined;
  /** @deprecated Use getYaClientBaseUrl. */
  getPublicShareViewerBaseUrl?: () => string | null | undefined;
}

function parseFileTarget(
  projectId: unknown,
  rawPath: unknown,
): { path: string; projectId: UrlProjectId } | { error: string } {
  if (typeof projectId !== "string" || !isUrlProjectId(projectId)) {
    return { error: "Invalid project ID format" };
  }
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { error: "path is required" };
  }
  let projectRoot: string;
  try {
    projectRoot = decodeProjectId(projectId);
  } catch {
    return { error: "Invalid project ID format" };
  }
  const normalized = normalizePublicShareProjectFilePath(rawPath, projectRoot);
  return normalized
    ? { projectId, path: normalized }
    : { error: "Invalid file path" };
}

function parseCreateRequest(
  value: unknown,
): { request: CreatePublicFileShareRequest } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Request body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const target = parseFileTarget(body.projectId, body.path);
  if ("error" in target) return target;
  if (body.title !== undefined && typeof body.title !== "string") {
    return { error: "title must be a string" };
  }
  return {
    request: {
      projectId: target.projectId,
      path: target.path,
      ...(body.title !== undefined ? { title: body.title } : {}),
    },
  };
}

function storageUnavailable(
  deps: PublicFileShareRoutesDeps,
): { error: string; retryable?: boolean; storageState?: string } | null {
  const readiness = deps.publicShareService.getReadiness();
  if (readiness.state === "ready") return null;
  return {
    error: readiness.error ?? `Public share store is ${readiness.state}`,
    retryable: readiness.state === "opening" || readiness.state === "migrating",
    storageState: readiness.state,
  };
}

function buildPublicFileShareUrl(
  secret: string,
  relayConfig: RelayConfigForPublicShare,
  yaClientBaseUrl: string,
  projectId: UrlProjectId,
  filePath: string,
): string {
  const url = new URL(buildPublicShareViewerUrl(secret, yaClientBaseUrl));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/file`;
  url.searchParams.set("h", relayConfig.username);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", filePath);
  url.searchParams.set("standalone", "1");
  const relayUrl = normalizeRelayUrl(relayConfig.url);
  if (relayUrl !== DEFAULT_RELAY_URL) url.searchParams.set("r", relayUrl);
  url.hash = "v=2&target=file";
  return url.toString();
}

export function createPublicFileShareRoutes(
  deps: PublicFileShareRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get("/public-file-shares", (c) => {
    const unavailable = storageUnavailable(deps);
    if (unavailable) {
      if (unavailable.retryable) c.header("Retry-After", "2");
      return c.json(unavailable, 503);
    }
    const target = parseFileTarget(
      c.req.query("projectId"),
      c.req.query("path"),
    );
    if ("error" in target) return c.json({ error: target.error }, 400);
    const response: PublicFileShareListResponse = {
      items: deps.publicShareService.getPublicFileShares(
        target.projectId,
        target.path,
      ),
    };
    return c.json(response);
  });

  routes.post("/public-file-shares", async (c) => {
    const unavailable = storageUnavailable(deps);
    if (unavailable) {
      if (unavailable.retryable) c.header("Retry-After", "2");
      return c.json(unavailable, 503);
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json<unknown>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseCreateRequest(rawBody);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (!(deps.getPublicSharesEnabled?.() ?? false)) {
      return c.json(
        {
          error:
            "Public Read-Only Share must be enabled in Advanced settings before creating links",
        },
        403,
      );
    }
    const relayConfig = deps.getRelayConfig?.() ?? null;
    if (!relayConfig?.url || !relayConfig.username) {
      return c.json(
        {
          error:
            "Remote relay must be configured before creating public share links",
        },
        400,
      );
    }
    if (!(deps.getRemoteAccessEnabled?.() ?? false)) {
      return c.json(
        {
          error:
            "Remote Access must be enabled before creating public share links",
        },
        400,
      );
    }
    if (!deps.fetchProjectFile) {
      return c.json({ error: "Project file access is unavailable" }, 503);
    }

    const body = parsed.request;
    const validation = await deps.fetchProjectFile(body.projectId, body.path, {
      raw: false,
    });
    if (!validation.ok) {
      await validation.body?.cancel();
      return c.json({ error: "File not found" }, 404);
    }
    await validation.body?.cancel();

    let yaClientBaseUrl: string;
    try {
      yaClientBaseUrl = resolveYaClientBaseUrl(
        deps.getYaClientBaseUrl?.(),
        deps.getPublicShareViewerBaseUrl?.(),
      );
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : "Invalid YA URL",
        },
        400,
      );
    }

    const created = await deps.publicShareService.createFileShare({
      projectId: body.projectId,
      path: body.path,
      title: body.title,
      buildPublicUrl: (secret) =>
        buildPublicFileShareUrl(
          secret,
          relayConfig,
          yaClientBaseUrl,
          body.projectId,
          body.path,
        ),
    });
    const response: CreatePublicFileShareResponse = {
      url: created.record.url,
      shareId: created.record.shareId,
      createdAt: created.record.createdAt,
      secretBits: created.secretBits,
    };
    return c.json(response);
  });

  routes.delete("/public-file-shares/:shareId", async (c) => {
    const unavailable = storageUnavailable(deps);
    if (unavailable) return c.json(unavailable, 503);
    const response: RevokePublicShareResponse = {
      revoked: await deps.publicShareService.revokeFileShare(
        c.req.param("shareId"),
      ),
    };
    return c.json(response);
  });

  return routes;
}
