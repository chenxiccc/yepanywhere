import {
  isPublicSessionSharePublicMetadata,
  isPublicSessionShareResponse,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareResponse,
  type RelayResponse,
} from "@yep-anywhere/shared";

export class PublicShareRelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PublicShareRelayError";
  }
}

export function parsePublicShareJsonResponse(response: RelayResponse): unknown {
  if (response.status >= 400) {
    const body = response.body as
      | { error?: unknown; retryable?: unknown }
      | string
      | null;
    const message =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : "Share not found";
    throw new PublicShareRelayError(
      message,
      response.status,
      Boolean(body && typeof body === "object" && body.retryable === true),
    );
  }
  if (response.status !== 200) {
    throw new PublicShareRelayError(
      "Share returned an unexpected response",
      response.status,
      false,
    );
  }
  if (typeof response.body === "string") {
    const contentType =
      response.headers?.["content-type"] ??
      response.headers?.["Content-Type"] ??
      "";
    if (contentType.includes("json")) {
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        throw new Error("Share response is invalid");
      }
    }
  }
  return response.body;
}

export function parsePublicShareMetadataResponse(
  response: RelayResponse,
): PublicSessionSharePublicMetadata {
  const body = parsePublicShareJsonResponse(response);
  if (!isPublicSessionSharePublicMetadata(body)) {
    throw new Error("Share metadata is invalid");
  }
  return body;
}

export function parseNegotiatedPublicShareMetadata(
  response: RelayResponse,
): PublicSessionSharePublicMetadata | null {
  if (response.status === 404) return null;
  return parsePublicShareMetadataResponse(response);
}

export function metadataFromPublicShareResponse(
  response: PublicSessionShareResponse,
): PublicSessionSharePublicMetadata {
  const metadata: PublicSessionSharePublicMetadata = {
    mode: response.share.mode,
    title: response.share.title,
    initialPrompt:
      typeof response.session.initialPrompt === "string"
        ? response.session.initialPrompt
        : null,
    projectName:
      response.share.source.projectName ?? response.session.projectName ?? null,
    provider: response.share.source.provider ?? response.session.provider,
    createdAt: response.share.createdAt,
    updatedAt: response.share.updatedAt,
    capturedAt: response.share.capturedAt,
    linkedFileMode: response.share.linkedFileMode,
  };
  if (!isPublicSessionSharePublicMetadata(metadata)) {
    throw new Error("Share metadata is invalid");
  }
  return metadata;
}

export function parsePublicShareResponse(
  response: RelayResponse,
): PublicSessionShareResponse {
  const body = parsePublicShareJsonResponse(response);
  if (!isPublicSessionShareResponse(body)) {
    throw new Error("Share response is invalid");
  }
  return body;
}

export function buildPublicShareSessionPath(options: {
  afterMessageId?: string;
  rawJson?: boolean;
  secret: string;
  viewerId: string;
}): string {
  const shareParams = new URLSearchParams({ viewerId: options.viewerId });
  if (options.afterMessageId) {
    shareParams.set("afterMessageId", options.afterMessageId);
  }
  if (options.rawJson) {
    shareParams.set("wire", "raw-json");
  }
  return `/public-api/shares/${encodeURIComponent(options.secret)}?${shareParams}`;
}
