import {
  DEFAULT_RELAY_URL,
  type AppSession,
  type CreatePublicSessionShareRequest,
  type CreatePublicSessionShareResponse,
  type FileContentResponse,
  type FreezePublicSessionLiveSharesResponse,
  type PublicSessionShareResponse,
  type PublicSessionShareSessionStatusResponse,
  type PublicSessionShareViewerActionResponse,
  type RevokePublicSessionSharesResponse,
  type UrlProjectId,
  isUrlProjectId,
  normalizeRelayUrl,
  parseLineColumn,
} from "@yep-anywhere/shared";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, posix, win32 } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { Hono } from "hono";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import type { RelayClientStatus } from "../services/RelayClientService.js";
import type { PublicShareService } from "../services/PublicShareService.js";
import { augmentEditToolUses } from "../sessions/persisted-augments.js";
import type { Message } from "../supervisor/types.js";
import {
  buildPublicShareViewerUrl,
  getDefaultPublicShareViewerBaseUrl,
  getDefaultYaClientBaseUrl,
  resolvePublicShareViewerBaseUrl,
  resolveYaClientBaseUrl,
} from "../utils/publicShareViewerUrl.js";

export interface RelayConfigForPublicShare {
  url: string;
  username: string;
}

export interface PublicShareRoutesDeps {
  publicShareService: PublicShareService;
  loadSession: (
    projectId: UrlProjectId,
    sessionId: string,
    options?: { afterMessageId?: string },
  ) => Promise<AppSession | null>;
  loadSessionUpdatedAt?: (
    projectId: UrlProjectId,
    sessionId: string,
  ) => Promise<string | null>;
  loadSessionSummary?: (
    projectId: UrlProjectId,
    sessionId: string,
  ) => Promise<Pick<
    AppSession,
    | "customTitle"
    | "fullTitle"
    | "initialPrompt"
    | "provider"
    | "title"
    | "updatedAt"
  > | null>;
  getRelayConfig?: () => RelayConfigForPublicShare | null;
  getPublicSharesEnabled?: () => boolean;
  getRemoteAccessEnabled?: () => boolean;
  getRelayStatus?: () => RelayClientStatus | null;
  getYaClientBaseUrl?: () => string | null | undefined;
  /** @deprecated Use getYaClientBaseUrl. */
  getPublicShareViewerBaseUrl?: () => string | null | undefined;
  fetchProjectFile?: (
    projectId: UrlProjectId,
    path: string,
    options: {
      download?: boolean;
      highlight?: boolean;
      lineEnd?: number;
      lineNumber?: number;
      raw?: boolean;
      projectRoot?: string;
      viewMode?: "full" | "range";
    },
  ) => Promise<Response>;
}

const PUBLIC_SHARE_RENDER_SOURCE_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".markdown",
  ".md",
  ".mdx",
]);
const PUBLIC_SHARE_RENDER_ASSET_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".png",
  ".svg",
  ".webm",
  ".webp",
]);
const MAX_PUBLIC_SHARE_TRANSITIVE_SOURCE_BYTES = 1024 * 1024;

function getPublicShareReadiness(deps: PublicShareRoutesDeps): {
  enabled: boolean;
  relayConfig: RelayConfigForPublicShare | null;
  configured: boolean;
  remoteAccessEnabled: boolean;
  relayStatus: RelayClientStatus | null;
  canCreate: boolean;
} {
  const enabled = deps.getPublicSharesEnabled?.() ?? false;
  const relayConfig = deps.getRelayConfig?.() ?? null;
  const configured = !!relayConfig?.url && !!relayConfig.username;
  const remoteAccessEnabled = deps.getRemoteAccessEnabled?.() ?? false;
  const relayStatus = deps.getRelayStatus?.() ?? null;
  const storageReady =
    deps.publicShareService.getReadiness().state === "ready";
  return {
    enabled,
    relayConfig,
    configured,
    remoteAccessEnabled,
    relayStatus,
    canCreate: enabled && configured && remoteAccessEnabled && storageReady,
  };
}

function parsePositiveIntegerQuery(
  value: string | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildPublicShareUrl(
  secret: string,
  relayConfig: RelayConfigForPublicShare,
  yaClientBaseUrl: string,
): string {
  const url = new URL(buildPublicShareViewerUrl(secret, yaClientBaseUrl));
  const relayUrl = normalizeRelayUrl(relayConfig.url);
  url.searchParams.set("h", relayConfig.username);
  if (relayUrl !== DEFAULT_RELAY_URL) {
    url.searchParams.set("r", relayUrl);
  }
  url.hash = "v=2";
  return url.toString();
}

function publicShareStoreUnavailable(
  c: Context,
  deps: PublicShareRoutesDeps,
): Response | null {
  const readiness = deps.publicShareService.getReadiness();
  if (readiness.state === "ready") return null;
  c.header("Retry-After", "2");
  return c.json(
    {
      error:
        readiness.error ?? `Public share store is ${readiness.state}`,
      retryable:
        readiness.state === "opening" || readiness.state === "migrating",
      storageState: readiness.state,
    },
    503,
  );
}

function contentToPlainText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const value = block as {
        content?: unknown;
        text?: unknown;
        type?: unknown;
      };
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (typeof value.content === "string") {
        return value.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizePromptPreview(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length > 700
    ? `${normalized.slice(0, 697).trimEnd()}...`
    : normalized;
}

function getInitialPromptPreview(session: AppSession): string | null {
  for (const message of session.messages) {
    if ((message as { type?: unknown }).type !== "user") {
      continue;
    }
    const content =
      contentToPlainText((message as { content?: unknown }).content) ||
      contentToPlainText(
        (message as { message?: { content?: unknown } }).message?.content,
      );
    const preview = normalizePromptPreview(content);
    if (preview) {
      return preview;
    }
  }
  return null;
}

function notFound(c: Context) {
  return c.json({ error: "Share not found" }, 404);
}

type SharePathFlavor = "posix" | "windows";

function getSharePathFlavor(pathValue: string): SharePathFlavor {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.includes("\\")
    ? "windows"
    : "posix";
}

function isAbsoluteSharePath(
  pathValue: string,
  flavor: SharePathFlavor,
): boolean {
  return flavor === "windows"
    ? win32.isAbsolute(pathValue)
    : posix.isAbsolute(pathValue);
}

function normalizeSharePath(
  pathValue: string,
  flavor: SharePathFlavor,
): string {
  return flavor === "windows"
    ? win32.normalize(pathValue)
    : posix.normalize(pathValue.replaceAll("\\", "/"));
}

function resolveSharePath(
  basePath: string,
  pathValue: string,
  flavor: SharePathFlavor,
): string {
  return flavor === "windows"
    ? win32.resolve(basePath, pathValue)
    : posix.resolve(basePath, pathValue.replaceAll("\\", "/"));
}

function relativeSharePath(
  fromPath: string,
  toPath: string,
  flavor: SharePathFlavor,
): string {
  return flavor === "windows"
    ? win32.relative(fromPath, toPath)
    : posix.relative(fromPath, toPath);
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const flavor = getSharePathFlavor(directory);
  const relativePath = relativeSharePath(
    resolveSharePath(directory, "", flavor),
    resolveSharePath(filePath, "", flavor),
    flavor,
  );
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !isAbsoluteSharePath(relativePath, flavor))
  );
}

function normalizePublicShareProjectFilePath(
  rawPath: string,
  projectRoot: string,
): string | null {
  const { path: parsedPath } = parseLineColumn(rawPath);
  const flavor = getSharePathFlavor(projectRoot);
  const normalizedRoot = resolveSharePath(projectRoot, "", flavor);

  if (isAbsoluteSharePath(parsedPath, flavor)) {
    const absolutePath = resolveSharePath(parsedPath, "", flavor);
    if (!isPathInsideDirectory(absolutePath, normalizedRoot)) {
      return null;
    }
    return relativeSharePath(normalizedRoot, absolutePath, flavor).replaceAll(
      "\\",
      "/",
    );
  }

  const normalized = normalizeSharePath(parsedPath, flavor);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("..") ||
    isAbsoluteSharePath(normalized, flavor)
  ) {
    return null;
  }
  return normalized.replaceAll("\\", "/");
}

async function loadLivePublicShareResponse(
  deps: PublicShareRoutesDeps,
  record: NonNullable<ReturnType<PublicShareService["getRecordBySecret"]>>,
): Promise<PublicSessionShareResponse | null> {
  const session = await deps.loadSession(
    record.source.projectId,
    record.source.sessionId,
  );
  return session
    ? deps.publicShareService.buildLiveResponse(record, session)
    : null;
}

function collectStringValues(value: unknown): string[] {
  const strings: string[] = [];
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      strings.push(current);
      continue;
    }
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    stack.push(...Object.values(current));
  }

  return strings;
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function publicShareSessionMentionsFile(
  session: AppSession,
  relativePath: string,
  projectRoot: string,
  projectId: UrlProjectId,
): boolean {
  const flavor = getSharePathFlavor(projectRoot);
  const absolutePath = resolveSharePath(projectRoot, relativePath, flavor);
  const candidates = new Set([
    relativePath,
    absolutePath,
    encodeURIComponent(relativePath),
    encodeURIComponent(absolutePath),
    `/projects/${projectId}/file?path=${encodeURIComponent(relativePath)}`,
    `/api/local-file?path=${encodeURIComponent(absolutePath)}`,
    `/api/local-image?path=${encodeURIComponent(absolutePath)}`,
  ]);

  for (const value of collectStringValues(session)) {
    const decoded = decodeURIComponentSafe(value);
    for (const candidate of candidates) {
      if (value.includes(candidate) || decoded?.includes(candidate)) {
        return true;
      }
    }
  }
  return false;
}

function hasPublicShareExtension(
  relativePath: string,
  extensions: ReadonlySet<string>,
): boolean {
  return extensions.has(extname(relativePath).toLowerCase());
}

function sanitizePathToken(value: string): string {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[),.;!?]+$/g, "");
}

function normalizeMentionedProjectFilePath(
  rawPath: string,
  projectRoot: string,
): string | null {
  const sanitized = sanitizePathToken(rawPath);
  return sanitized
    ? normalizePublicShareProjectFilePath(sanitized, projectRoot)
    : null;
}

function collectPublicShareMentionedProjectFiles(
  session: AppSession,
  projectRoot: string,
  projectId: UrlProjectId,
): Set<string> {
  const files = new Set<string>();
  const flavor = getSharePathFlavor(projectRoot);
  const normalizedRoot = resolveSharePath(projectRoot, "", flavor).replace(
    /[\\/]+$/,
    "",
  );
  const rootPattern = new RegExp(
    `${escapeRegExp(normalizedRoot)}/[^\\s"'<>)]*\\.[A-Za-z0-9]+(?::\\d+)?`,
    "g",
  );
  const localApiPattern =
    /(?:https?:\/\/[^\s"'<>)]*)?\/api\/local-(?:file|image)\?[^\s"'<>)]*/g;
  const projectFilePattern =
    /(?:https?:\/\/[^\s"'<>)]*)?\/projects\/([^/\s"'<>]+)\/file\?[^\s"'<>)]*/g;
  const relativePathPattern =
    /(?:^|[\s([`'"])([A-Za-z0-9_.@/-]+\.[A-Za-z0-9]{1,16})(?::\d+)?/gi;

  const addPath = (rawPath: string | null) => {
    if (!rawPath) {
      return;
    }
    const normalized = normalizeMentionedProjectFilePath(rawPath, projectRoot);
    if (normalized) {
      files.add(normalized);
    }
  };

  for (const value of collectStringValues(session)) {
    const decoded = decodeURIComponentSafe(value);
    const textVariants =
      decoded && decoded !== value ? [value, decoded] : [value];
    for (const text of textVariants) {
      for (const match of text.matchAll(rootPattern)) {
        addPath(match[0] ?? null);
      }
      for (const match of text
        .replaceAll("&amp;", "&")
        .matchAll(localApiPattern)) {
        try {
          const url = new URL(match[0] ?? "", "http://share.local");
          addPath(url.searchParams.get("path"));
        } catch {
          // Ignore malformed URL-looking substrings.
        }
      }
      for (const match of text
        .replaceAll("&amp;", "&")
        .matchAll(projectFilePattern)) {
        const rawProjectId = match[1];
        const matchedProjectId = rawProjectId
          ? decodeURIComponentSafe(rawProjectId)
          : null;
        if (matchedProjectId !== projectId) {
          continue;
        }
        try {
          const url = new URL(match[0] ?? "", "http://share.local");
          addPath(url.searchParams.get("path"));
        } catch {
          // Ignore malformed URL-looking substrings.
        }
      }
      for (const match of text.matchAll(relativePathPattern)) {
        addPath(match[1] ?? null);
      }
    }
  }

  return files;
}

function extractLocalRenderReferences(content: string): string[] {
  const references = new Set<string>();
  const markdownLinkPattern =
    /!?\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  const htmlReferencePattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const cssUrlPattern = /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi;

  for (const pattern of [
    markdownLinkPattern,
    htmlReferencePattern,
    cssUrlPattern,
  ]) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        references.add(match[1]);
      }
    }
  }

  return Array.from(references);
}

function normalizeRenderReferencePath(
  rawReference: string,
  sourceRelativePath: string,
  projectRoot: string,
  projectId: UrlProjectId,
): string | null {
  const reference = sanitizePathToken(rawReference).replaceAll("&amp;", "&");
  if (!reference || reference.startsWith("#")) {
    return null;
  }

  try {
    const url = new URL(reference, "http://share.local");
    if (url.origin !== "http://share.local") {
      return null;
    }
    if (
      url.pathname === "/api/local-file" ||
      url.pathname === "/api/local-image"
    ) {
      return normalizeMentionedProjectFilePath(
        url.searchParams.get("path") ?? "",
        projectRoot,
      );
    }
    const projectFileMatch = /^\/projects\/([^/]+)\/file$/.exec(url.pathname);
    if (projectFileMatch?.[1]) {
      const matchedProjectId = decodeURIComponentSafe(projectFileMatch[1]);
      if (matchedProjectId !== projectId) {
        return null;
      }
      return normalizeMentionedProjectFilePath(
        url.searchParams.get("path") ?? "",
        projectRoot,
      );
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      return null;
    }
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      return null;
    }
  }

  const pathOnly = reference.split(/[?#]/, 1)[0] ?? "";
  if (!pathOnly) {
    return null;
  }
  if (pathOnly.startsWith("/")) {
    return normalizeMentionedProjectFilePath(pathOnly, projectRoot);
  }

  const flavor = getSharePathFlavor(projectRoot);
  const sourceDir = dirname(
    resolveSharePath(projectRoot, sourceRelativePath, flavor),
  );
  return normalizeMentionedProjectFilePath(
    resolveSharePath(sourceDir, pathOnly, flavor),
    projectRoot,
  );
}

async function publicShareSessionMentionsRenderAsset(
  session: AppSession,
  relativePath: string,
  projectRoot: string,
  projectId: UrlProjectId,
): Promise<boolean> {
  if (
    !hasPublicShareExtension(relativePath, PUBLIC_SHARE_RENDER_ASSET_EXTENSIONS)
  ) {
    return false;
  }

  const sourcePaths = Array.from(
    collectPublicShareMentionedProjectFiles(session, projectRoot, projectId),
  ).filter((sourcePath) =>
    hasPublicShareExtension(sourcePath, PUBLIC_SHARE_RENDER_SOURCE_EXTENSIONS),
  );

  for (const sourcePath of sourcePaths.slice(0, 50)) {
    const flavor = getSharePathFlavor(projectRoot);
    const absoluteSourcePath = resolveSharePath(
      projectRoot,
      sourcePath,
      flavor,
    );
    if (!isPathInsideDirectory(absoluteSourcePath, projectRoot)) {
      continue;
    }
    try {
      const stats = await stat(absoluteSourcePath);
      if (
        !stats.isFile() ||
        stats.size > MAX_PUBLIC_SHARE_TRANSITIVE_SOURCE_BYTES
      ) {
        continue;
      }
      const content = await readFile(absoluteSourcePath, "utf-8");
      for (const reference of extractLocalRenderReferences(content)) {
        if (
          normalizeRenderReferencePath(
            reference,
            sourcePath,
            projectRoot,
            projectId,
          ) === relativePath
        ) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}

export async function buildPublicSharePresentation(
  session: AppSession,
  projectRoot: string,
  projectId: UrlProjectId,
): Promise<{ version: 1; authorizedPaths: string[] }> {
  const authorizedPaths = collectPublicShareMentionedProjectFiles(
    session,
    projectRoot,
    projectId,
  );
  const sourcePaths = [...authorizedPaths].filter((sourcePath) =>
    hasPublicShareExtension(sourcePath, PUBLIC_SHARE_RENDER_SOURCE_EXTENSIONS),
  );
  for (const sourcePath of sourcePaths.slice(0, 50)) {
    const flavor = getSharePathFlavor(projectRoot);
    const absoluteSourcePath = resolveSharePath(
      projectRoot,
      sourcePath,
      flavor,
    );
    if (!isPathInsideDirectory(absoluteSourcePath, projectRoot)) continue;
    try {
      const stats = await stat(absoluteSourcePath);
      if (
        !stats.isFile() ||
        stats.size > MAX_PUBLIC_SHARE_TRANSITIVE_SOURCE_BYTES
      ) {
        continue;
      }
      const content = await readFile(absoluteSourcePath, "utf8");
      for (const reference of extractLocalRenderReferences(content)) {
        const normalized = normalizeRenderReferencePath(
          reference,
          sourcePath,
          projectRoot,
          projectId,
        );
        if (normalized) authorizedPaths.add(normalized);
      }
    } catch {
      // A disappearing render source simply contributes no transitive grant.
    }
  }
  return {
    version: 1,
    authorizedPaths: [...authorizedPaths].sort(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicShareFileRawUrl(
  secret: string,
  relativePath: string,
  viewerId?: string,
): string {
  const params = new URLSearchParams({ path: relativePath });
  if (viewerId) params.set("viewerId", viewerId);
  return `/public-api/shares/${encodeURIComponent(secret)}/files/raw?${params}`;
}

async function servePublicShareProjectFile(
  c: Context,
  deps: PublicShareRoutesDeps,
  options: { raw: boolean },
): Promise<Response> {
  if (!(deps.getPublicSharesEnabled?.() ?? false)) {
    return notFound(c);
  }
  const unavailable = publicShareStoreUnavailable(c, deps);
  if (unavailable) return unavailable;
  if (!deps.fetchProjectFile) {
    return notFound(c);
  }

  const secret = c.req.param("secret");
  if (!secret) {
    return notFound(c);
  }
  const record = deps.publicShareService.getRecordBySecret(secret);
  if (!record) {
    return notFound(c);
  }
  if (record.repairRequired) {
    return c.json(
      {
        error:
          "This migrated frozen share needs source-session repair before it can be served",
        repairRequired: true,
        retryable: false,
      },
      503,
    );
  }
  const viewerId = c.req.query("viewerId");
  if (
    viewerId &&
    deps.publicShareService.isViewerDisconnected(record, viewerId)
  ) {
    return notFound(c);
  }

  let projectRoot: string;
  try {
    projectRoot = decodeProjectId(record.source.projectId);
  } catch {
    return notFound(c);
  }

  const rawPath = c.req.query("path");
  if (!rawPath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }
  const relativePath = normalizePublicShareProjectFilePath(
    rawPath,
    projectRoot,
  );
  if (!relativePath) {
    return c.json({ error: "Invalid file path" }, 400);
  }

  let authorized = false;
  const viewerHasSnapshot = Boolean(
    viewerId && record.viewerSnapshots?.[viewerId],
  );
  if (record.mode === "frozen" || viewerHasSnapshot) {
    const presentation =
      await deps.publicShareService.getFrozenPresentation(record, viewerId);
    authorized = presentation?.authorizedPaths.includes(relativePath) ?? false;
  } else {
    const shareResponse = await loadLivePublicShareResponse(
      deps,
      record,
    );
    authorized = Boolean(
      shareResponse &&
        (publicShareSessionMentionsFile(
          shareResponse.session,
          relativePath,
          projectRoot,
          record.source.projectId,
        ) ||
          (await publicShareSessionMentionsRenderAsset(
            shareResponse.session,
            relativePath,
            projectRoot,
            record.source.projectId,
          ))),
    );
  }
  if (!authorized) {
    return notFound(c);
  }

  const lineNumber = parsePositiveIntegerQuery(c.req.query("line"));
  const lineEnd = parsePositiveIntegerQuery(c.req.query("lineEnd"));
  const fileOptions: Parameters<
    NonNullable<PublicShareRoutesDeps["fetchProjectFile"]>
  >[2] = {
    download: c.req.query("download") === "true",
    highlight: c.req.query("highlight") === "true",
    raw: options.raw,
  };
  if (lineNumber !== undefined) {
    fileOptions.lineNumber = lineNumber;
  }
  if (lineEnd !== undefined) {
    fileOptions.lineEnd = lineEnd;
  }
  if (c.req.query("view") === "range") {
    fileOptions.viewMode = "range";
  }

  const response = await deps.fetchProjectFile(
    record.source.projectId,
    relativePath,
    {
      ...fileOptions,
      ...(deps.publicShareService.getFrozenProjectRoot(record, viewerId)
        ? {
            projectRoot:
              deps.publicShareService.getFrozenProjectRoot(record, viewerId) ??
              undefined,
          }
        : {}),
    },
  );

  if (options.raw) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (!response.ok) {
    return response;
  }

  const body = (await response.json()) as FileContentResponse;
  body.rawUrl = publicShareFileRawUrl(secret, relativePath, viewerId);
  c.header("Cache-Control", "no-store");
  return c.json(body);
}

function streamFrozenPublicShareResponse(
  deps: PublicShareRoutesDeps,
  record: NonNullable<ReturnType<PublicShareService["getRecordBySecret"]>>,
  viewerId?: string,
): Response | null {
  const frozen = deps.publicShareService.getFrozenSessionStream(
    record,
    viewerId,
  );
  if (!frozen) return null;
  const share = {
    mode: "frozen" as const,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capturedAt: frozen.capturedAt,
    linkedFileMode: frozen.linkedFileMode,
    activeViewerCount: deps.publicShareService.getActiveViewerCount(record),
    source: record.source,
  };
  const body = Readable.from(
    (async function* () {
      yield Buffer.from(`{"share":${JSON.stringify(share)},"session":`);
      for await (const chunk of frozen.stream) yield chunk;
      yield Buffer.from("}");
    })(),
  );
  return new Response(Readable.toWeb(body) as ReadableStream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-yep-public-share+json; charset=utf-8",
    },
  });
}

function getSessionParams(
  c: Context,
): { projectId: UrlProjectId; sessionId: string } | { error: Response } {
  const projectId = c.req.param("projectId");
  const sessionId = c.req.param("sessionId");
  if (typeof projectId !== "string" || !isUrlProjectId(projectId)) {
    return { error: c.json({ error: "Invalid project ID format" }, 400) };
  }
  if (!sessionId || typeof sessionId !== "string") {
    return { error: c.json({ error: "sessionId is required" }, 400) };
  }
  return { projectId, sessionId };
}

async function getPublicShareCaptureOptions(
  session: AppSession,
  projectId: UrlProjectId,
): Promise<{
  presentation: { version: 1; authorizedPaths: string[] };
  projectRoot: string;
}> {
  const projectRoot = decodeProjectId(projectId);
  return {
    projectRoot,
    presentation: await buildPublicSharePresentation(
      session,
      projectRoot,
      projectId,
    ),
  };
}

export function createPublicShareRoutes(deps: PublicShareRoutesDeps): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const readiness = getPublicShareReadiness(deps);
    const storage = deps.publicShareService.getReadiness();
    let yaClientBaseUrl: string | null = null;
    let viewerBaseUrl: string | null = null;
    let yaClientBaseUrlError: string | undefined;
    try {
      yaClientBaseUrl = resolveYaClientBaseUrl(
        deps.getYaClientBaseUrl?.(),
        deps.getPublicShareViewerBaseUrl?.(),
      );
      viewerBaseUrl = resolvePublicShareViewerBaseUrl(yaClientBaseUrl);
    } catch (error) {
      yaClientBaseUrlError =
        error instanceof Error ? error.message : "Invalid YA URL";
    }
    return c.json({
      enabled: readiness.enabled,
      configured: readiness.configured,
      requiresRelay: true,
      remoteAccessEnabled: readiness.remoteAccessEnabled,
      relayStatus: readiness.relayStatus,
      relayUrl: readiness.relayConfig?.url ?? null,
      relayUsername: readiness.relayConfig?.username ?? null,
      canCreate: readiness.canCreate,
      storageState: readiness.enabled ? storage.state : "disabled",
      storageError: storage.error,
      totalValidLinks:
        storage.state === "ready"
          ? deps.publicShareService.getValidShareCount()
          : null,
      yaClientBaseUrl,
      defaultYaClientBaseUrl: getDefaultYaClientBaseUrl(),
      viewerBaseUrl,
      defaultViewerBaseUrl: getDefaultPublicShareViewerBaseUrl(),
      ...(yaClientBaseUrlError
        ? {
            yaClientBaseUrlError,
            viewerBaseUrlError: yaClientBaseUrlError,
          }
        : {}),
    });
  });

  app.get("/sessions/:projectId/:sessionId", async (c) => {
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const sessionUpdatedAt = deps.loadSessionUpdatedAt
      ? await deps.loadSessionUpdatedAt(params.projectId, params.sessionId)
      : (await deps.loadSession(params.projectId, params.sessionId))?.updatedAt;
    const response: PublicSessionShareSessionStatusResponse =
      deps.publicShareService.getSessionShareStatus(
        params.projectId,
        params.sessionId,
        { sessionUpdatedAt },
      );
    return c.json(response);
  });

  app.delete("/sessions/:projectId/:sessionId", async (c) => {
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const response: RevokePublicSessionSharesResponse =
      await deps.publicShareService.revokeSessionShares(
        params.projectId,
        params.sessionId,
      );
    return c.json(response);
  });

  app.post("/sessions/:projectId/:sessionId/freeze-live", async (c) => {
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const session = await deps.loadSession(params.projectId, params.sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const response: FreezePublicSessionLiveSharesResponse =
      await deps.publicShareService.freezeSessionLiveShares(
        params.projectId,
        params.sessionId,
        session,
        await getPublicShareCaptureOptions(session, params.projectId),
      );
    return c.json(response);
  });

  app.post(
    "/sessions/:projectId/:sessionId/viewers/:viewerId/freeze",
    async (c) => {
      const unavailable = publicShareStoreUnavailable(c, deps);
      if (unavailable) return unavailable;
      const params = getSessionParams(c);
      if ("error" in params) return params.error;
      const viewerId = c.req.param("viewerId");
      const session = await deps.loadSession(
        params.projectId,
        params.sessionId,
      );
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      const response: PublicSessionShareViewerActionResponse =
        await deps.publicShareService.freezeSessionViewerToken(
          params.projectId,
          params.sessionId,
          viewerId,
          session,
          await getPublicShareCaptureOptions(session, params.projectId),
        );
      return c.json(response);
    },
  );

  app.delete("/sessions/:projectId/:sessionId/viewers/:viewerId", async (c) => {
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const params = getSessionParams(c);
    if ("error" in params) return params.error;
    const viewerId = c.req.param("viewerId");
    const response: PublicSessionShareViewerActionResponse =
      await deps.publicShareService.disconnectSessionViewerToken(
        params.projectId,
        params.sessionId,
        viewerId,
      );
    return c.json(response);
  });

  app.post("/", async (c) => {
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    let body: CreatePublicSessionShareRequest;
    try {
      body = await c.req.json<CreatePublicSessionShareRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!isUrlProjectId(body.projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return c.json({ error: "sessionId is required" }, 400);
    }
    if (body.mode !== "frozen" && body.mode !== "live") {
      return c.json({ error: "mode must be frozen or live" }, 400);
    }
    const readiness = getPublicShareReadiness(deps);
    if (!readiness.enabled) {
      return c.json(
        {
          error:
            "Public Read-Only Share must be enabled in Advanced settings before creating links",
        },
        403,
      );
    }

    const relayConfig = readiness.relayConfig;
    if (!relayConfig?.url || !relayConfig.username) {
      return c.json(
        {
          error:
            "Remote relay must be configured before creating public share links",
        },
        400,
      );
    }
    if (!readiness.remoteAccessEnabled) {
      return c.json(
        {
          error:
            "Remote Access must be enabled before creating public share links",
        },
        400,
      );
    }

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

    let session: AppSession | null = null;
    let sessionSummary: Pick<
      AppSession,
      | "customTitle"
      | "fullTitle"
      | "initialPrompt"
      | "provider"
      | "title"
      | "updatedAt"
    > | null = null;
    if (body.mode === "frozen" || !deps.loadSessionSummary) {
      session = await deps.loadSession(body.projectId, body.sessionId);
      sessionSummary = session;
    } else {
      sessionSummary = await deps.loadSessionSummary(
        body.projectId,
        body.sessionId,
      );
    }
    if (!sessionSummary) {
      return c.json({ error: "Session not found" }, 404);
    }

    const title =
      body.title ?? sessionSummary.customTitle ?? sessionSummary.title;
    const projectRoot = decodeProjectId(body.projectId);
    const projectName = getProjectName(projectRoot);
    const initialPrompt =
      normalizePromptPreview(sessionSummary.initialPrompt ?? "") ??
      (session ? getInitialPromptPreview(session) : null) ??
      normalizePromptPreview(sessionSummary.fullTitle ?? "") ??
      normalizePromptPreview(body.initialPrompt ?? "");
    const { secret, secretBits, record } =
      await deps.publicShareService.createShare({
        mode: body.mode,
        title,
        initialPrompt,
        source: {
          projectId: body.projectId,
          sessionId: body.sessionId,
          projectName,
          provider: sessionSummary.provider,
        },
        ...(body.mode === "frozen" && session ? { snapshot: session } : {}),
        ...(body.mode === "frozen" && session
          ? await getPublicShareCaptureOptions(session, body.projectId)
          : {}),
      });

    const response: CreatePublicSessionShareResponse = {
      url: buildPublicShareUrl(
        secret,
        relayConfig,
        yaClientBaseUrl,
      ),
      mode: record.mode,
      createdAt: record.createdAt,
      secretBits,
      linkedFileMode: record.linkedFileMode,
    };
    return c.json(response);
  });

  return app;
}

export function createPublicSharePublicRoutes(
  deps: PublicShareRoutesDeps,
): Hono {
  const app = new Hono();

  app.get("/:secret/metadata", (c) => {
    if (!(deps.getPublicSharesEnabled?.() ?? false)) return notFound(c);
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const record = deps.publicShareService.getRecordBySecret(
      c.req.param("secret"),
    );
    if (!record) return notFound(c);
    if (record.repairRequired) {
      return c.json(
        {
          error:
            "This migrated frozen share needs source-session repair before it can be served",
          repairRequired: true,
          retryable: false,
        },
        503,
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json(deps.publicShareService.getPublicMetadata(record));
  });

  app.get("/:secret/files/raw", (c) =>
    servePublicShareProjectFile(c, deps, { raw: true }),
  );

  app.get("/:secret/files", (c) =>
    servePublicShareProjectFile(c, deps, { raw: false }),
  );

  app.get("/:secret", async (c) => {
    if (!(deps.getPublicSharesEnabled?.() ?? false)) {
      return notFound(c);
    }
    const unavailable = publicShareStoreUnavailable(c, deps);
    if (unavailable) return unavailable;
    const secret = c.req.param("secret");
    const viewerId = c.req.query("viewerId");
    const afterMessageId = c.req.query("afterMessageId");
    const record = deps.publicShareService.getRecordBySecret(secret);
    if (!record) {
      return notFound(c);
    }
    if (record.repairRequired) {
      return c.json(
        {
          error:
            "This migrated frozen share needs source-session repair before it can be served",
          repairRequired: true,
          retryable: false,
        },
        503,
      );
    }
    if (
      viewerId &&
      deps.publicShareService.isViewerDisconnected(record, viewerId)
    ) {
      return notFound(c);
    }

    if (
      c.req.query("wire") === "raw-json" &&
      (record.mode === "frozen" ||
        (viewerId && record.viewerSnapshots?.[viewerId]))
    ) {
      const response = streamFrozenPublicShareResponse(
        deps,
        record,
        viewerId,
      );
      if (!response) return notFound(c);
      if (viewerId) {
        deps.publicShareService.recordViewerHeartbeat(record, viewerId);
      }
      return response;
    }

    let response: PublicSessionShareResponse | null;
    if (viewerId) {
      response = await deps.publicShareService.getViewerSnapshotResponse(
        record,
        viewerId,
      );
    } else {
      response = null;
    }

    if (!response && record.mode === "frozen") {
      response = await deps.publicShareService.getFrozenShareBySecret(secret);
    } else if (!response) {
      const session = await deps.loadSession(
        record.source.projectId,
        record.source.sessionId,
        { afterMessageId },
      );
      response = session
        ? deps.publicShareService.buildLiveResponse(record, session)
        : null;
    }

    if (!response) {
      return notFound(c);
    }

    await augmentEditToolUses(response.session.messages as Message[]);
    response.share.activeViewerCount = viewerId
      ? deps.publicShareService.recordViewerHeartbeat(record, viewerId)
      : deps.publicShareService.getActiveViewerCount(record);

    c.header("Cache-Control", "no-store");
    return c.json(response);
  });

  return app;
}
