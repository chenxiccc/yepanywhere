import type {
  PublicSessionSharePublicMetadata,
  PublicSessionShareResponse,
} from "@yep-anywhere/shared";
import {
  PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES,
  fetchPublicShareRelayResponse,
  type PublicShareRelayRequestOptions,
} from "./publicShareRelayConnection";
import {
  buildPublicShareSessionPath,
  parsePublicShareJsonResponse,
  parsePublicShareMetadataResponse,
  parsePublicShareResponse,
} from "./publicShareRelayResponse";

export { fetchPublicShareV2ViaRelay } from "./publicShareFrozenTransfer";
export {
  fetchPublicShareRelayResponse,
  type PublicShareRelayRequestOptions,
} from "./publicShareRelayConnection";
export { PublicShareRelayError } from "./publicShareRelayResponse";

export async function fetchPublicShareJsonViaRelay<T>(
  options: PublicShareRelayRequestOptions,
): Promise<T> {
  return parsePublicShareJsonResponse(
    await fetchPublicShareRelayResponse(options),
  ) as T;
}

export async function fetchPublicShareBlobViaRelay(
  options: PublicShareRelayRequestOptions,
): Promise<Blob> {
  const response = await fetchPublicShareRelayResponse(options);
  if (response.status >= 400) {
    throw new Error("Share not found");
  }

  const contentType =
    response.headers?.["content-type"] ||
    response.headers?.["Content-Type"] ||
    "application/octet-stream";
  const body = response.body as unknown;
  if (
    body &&
    typeof body === "object" &&
    (body as { _binary?: unknown })._binary === true &&
    typeof (body as { data?: unknown }).data === "string"
  ) {
    const binary = atob((body as { data: string }).data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: contentType });
  }

  if (typeof body === "string") {
    return new Blob([body], { type: contentType });
  }

  return new Blob([JSON.stringify(body ?? null)], {
    type: contentType || "application/json",
  });
}

export async function fetchPublicShareViaRelay(options: {
  afterMessageId?: string;
  relayUrl: string;
  relayUsername: string;
  secret: string;
  viewerId: string;
  rawJson?: boolean;
  signal?: AbortSignal;
}): Promise<PublicSessionShareResponse> {
  return parsePublicShareResponse(
    await fetchPublicShareRelayResponse({
      relayUrl: options.relayUrl,
      relayUsername: options.relayUsername,
      path: buildPublicShareSessionPath(options),
      signal: options.signal,
    }),
  );
}

export async function fetchPublicShareMetadataViaRelay(options: {
  relayUrl: string;
  relayUsername: string;
  secret: string;
  viewerId?: string;
}): Promise<PublicSessionSharePublicMetadata> {
  const params = new URLSearchParams();
  if (options.viewerId) params.set("viewerId", options.viewerId);
  const query = params.size > 0 ? `?${params}` : "";
  return parsePublicShareMetadataResponse(
    await fetchPublicShareRelayResponse({
      relayUrl: options.relayUrl,
      relayUsername: options.relayUsername,
      path: `/public-api/shares/${encodeURIComponent(options.secret)}/metadata${query}`,
      maxResponseBytes: PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES,
    }),
  );
}
