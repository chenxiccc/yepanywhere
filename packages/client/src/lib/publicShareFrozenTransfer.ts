import {
  PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT,
  isAppSession,
  isPublicShareSessionChunksMetadata,
  isPublicSessionShareResponse,
  type AppSession,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareResponse,
  type PublicShareSessionChunksMetadata,
  type RelayResponse,
} from "@yep-anywhere/shared";
import {
  PUBLIC_SHARE_RELAY_CHUNK_FRAME_MAX_BYTES,
  PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES,
  PublicShareRelayConnection,
  asPublicShareError,
} from "./publicShareRelayConnection";
import {
  buildPublicShareSessionPath,
  metadataFromPublicShareResponse,
  parseNegotiatedPublicShareMetadata,
  parsePublicShareJsonResponse,
  parsePublicShareResponse,
} from "./publicShareRelayResponse";

const PUBLIC_SHARE_RELAY_CURSOR_MAX_CHARS = 1024;

function publicShareAbortError(): Error {
  const error = new Error("Share request cancelled");
  error.name = "AbortError";
  return error;
}

function getRelayResponseHeader(
  response: RelayResponse,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function parseRelayIntegerHeader(
  response: RelayResponse,
  name: string,
): number {
  const raw = getRelayResponseHeader(response, name);
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error("Share transfer metadata is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("Share transfer metadata is invalid");
  }
  return value;
}

function decodeRelayBinaryBody(
  response: RelayResponse,
  maxBytes: number,
): Uint8Array {
  const body = response.body as unknown;
  const data =
    body && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined;
  if (
    !body ||
    typeof body !== "object" ||
    (body as { _binary?: unknown })._binary !== true ||
    typeof data !== "string" ||
    data.length > 4 * Math.ceil(maxBytes / 3) ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error("Share transfer chunk is invalid");
  }
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new Error("Share transfer chunk is invalid");
  }
}

function validateSessionChunksMetadata(
  metadata: PublicSessionSharePublicMetadata,
): {
  chunks: PublicShareSessionChunksMetadata;
  expectedChunkCount: number;
} {
  const chunks = metadata.sessionChunks;
  if (!isPublicShareSessionChunksMetadata(chunks)) {
    throw new Error("Share transfer metadata is invalid");
  }
  const expectedChunkCount = Math.ceil(
    chunks.compressedBytes / PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  );
  if (
    expectedChunkCount < 1 ||
    expectedChunkCount > PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT
  ) {
    throw new Error("Share transfer metadata is invalid");
  }
  return { chunks, expectedChunkCount };
}

async function collectDecodedSession(
  readable: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  let receivedBytes = 0;
  const abortListener = () => {
    void reader.cancel(publicShareAbortError()).catch(() => undefined);
  };
  signal?.addEventListener("abort", abortListener, { once: true });
  try {
    if (signal?.aborted) throw publicShareAbortError();
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw publicShareAbortError();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > expectedBytes) {
        throw new Error("Share transfer decompressed size does not match");
      }
      try {
        decoded += decoder.decode(value, { stream: true });
      } catch {
        throw new Error("Share session data is invalid");
      }
    }
    if (receivedBytes !== expectedBytes) {
      throw new Error("Share transfer decompressed size does not match");
    }
    try {
      decoded += decoder.decode();
    } catch {
      throw new Error("Share session data is invalid");
    }
    return decoded;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortListener);
    reader.releaseLock();
  }
}

function isClosedRelayConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "Relay connection closed" ||
      error.message === "Relay connection failed")
  );
}

async function fetchRawPublicShareWithConnectionFallback(
  connection: PublicShareRelayConnection,
  options: {
    relayUrl: string;
    relayUsername: string;
    secret: string;
    signal?: AbortSignal;
    viewerId: string;
  },
): Promise<PublicSessionShareResponse> {
  const path = buildPublicShareSessionPath({
    secret: options.secret,
    viewerId: options.viewerId,
    rawJson: true,
  });
  const request = (target: PublicShareRelayConnection) =>
    target.request(path, PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES);
  let freshConnection: PublicShareRelayConnection | undefined;
  try {
    if (connection.isTerminal()) {
      freshConnection = new PublicShareRelayConnection(
        options.relayUrl,
        options.relayUsername,
        options.signal,
      );
      return parsePublicShareResponse(await request(freshConnection));
    }
    try {
      return parsePublicShareResponse(await request(connection));
    } catch (error) {
      if (
        options.signal?.aborted ||
        !connection.isTerminal() ||
        !isClosedRelayConnectionError(error)
      ) {
        throw error;
      }
      freshConnection = new PublicShareRelayConnection(
        options.relayUrl,
        options.relayUsername,
        options.signal,
      );
      return parsePublicShareResponse(await request(freshConnection));
    }
  } finally {
    freshConnection?.close();
  }
}

async function fetchFrozenSessionChunks(
  connection: PublicShareRelayConnection,
  options: { secret: string; signal?: AbortSignal; viewerId: string },
  metadata: PublicSessionSharePublicMetadata,
): Promise<PublicSessionShareResponse> {
  const { chunks: chunksMetadata, expectedChunkCount } =
    validateSessionChunksMetadata(metadata);
  const decompressor = new DecompressionStream("gzip");
  const writer = decompressor.writable.getWriter();
  const decodedSessionPromise = collectDecodedSession(
    decompressor.readable,
    chunksMetadata.sessionBytes,
    options.signal,
  );
  let consumerError: Error | undefined;
  let rejectConsumerFailure!: (error: Error) => void;
  const consumerFailure = new Promise<never>((_resolve, reject) => {
    rejectConsumerFailure = reject;
  });
  void consumerFailure.catch(() => undefined);
  void decodedSessionPromise.catch((error: unknown) => {
    const transferError = asPublicShareError(error);
    consumerError = transferError;
    connection.close(transferError);
    rejectConsumerFailure(transferError);
  });
  let abortError: Error | undefined;
  let rejectAbort!: (error: Error) => void;
  const abortFailure = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void abortFailure.catch(() => undefined);
  const abortListener = () => {
    abortError = publicShareAbortError();
    rejectAbort(abortError);
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (options.signal?.aborted) abortListener();
  const transfer = async <T>(start: () => Promise<T>): Promise<T> => {
    const failure = consumerError ?? abortError;
    if (failure) throw failure;
    const result = await Promise.race([start(), consumerFailure, abortFailure]);
    const completedFailure = consumerError ?? abortError;
    if (completedFailure) throw completedFailure;
    return result;
  };
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedIndex = 0;
  let expectedOffset = 0;

  try {
    while (true) {
      if (expectedIndex >= expectedChunkCount) {
        throw new Error("Share transfer chunk order or integrity is invalid");
      }
      const params = new URLSearchParams({ viewerId: options.viewerId });
      if (cursor) params.set("cursor", cursor);
      const response = await transfer(() =>
        connection.request(
          `/public-api/shares/${encodeURIComponent(options.secret)}/session-chunks?${params}`,
          PUBLIC_SHARE_RELAY_CHUNK_FRAME_MAX_BYTES,
        ),
      );
      if (response.status !== 200) {
        parsePublicShareJsonResponse(response);
      }

      const bytes = decodeRelayBinaryBody(
        response,
        PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      );
      const index = parseRelayIntegerHeader(
        response,
        "X-Yep-Public-Share-Chunk-Index",
      );
      const offset = parseRelayIntegerHeader(
        response,
        "X-Yep-Public-Share-Chunk-Offset",
      );
      const nextOffset = parseRelayIntegerHeader(
        response,
        "X-Yep-Public-Share-Next-Offset",
      );
      const compressedBytes = parseRelayIntegerHeader(
        response,
        "X-Yep-Public-Share-Compressed-Bytes",
      );
      const revisionId = getRelayResponseHeader(
        response,
        "X-Yep-Public-Share-Revision",
      );
      const integrityWitness = getRelayResponseHeader(
        response,
        "X-Yep-Public-Share-Integrity",
      );
      const finalHeader = getRelayResponseHeader(
        response,
        "X-Yep-Public-Share-Final",
      );
      const nextCursor = getRelayResponseHeader(
        response,
        "X-Yep-Public-Share-Next-Cursor",
      );
      const final = finalHeader === "true";
      const expectedFinal = expectedIndex === expectedChunkCount - 1;
      const expectedChunkBytes = expectedFinal
        ? chunksMetadata.compressedBytes - expectedOffset
        : PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES;

      if (
        (finalHeader !== "true" && finalHeader !== "false") ||
        index !== expectedIndex ||
        offset !== expectedOffset ||
        nextOffset !== offset + bytes.byteLength ||
        bytes.byteLength !== expectedChunkBytes ||
        compressedBytes !== chunksMetadata.compressedBytes ||
        revisionId !== chunksMetadata.revisionId ||
        integrityWitness !== chunksMetadata.integrityWitness ||
        nextOffset > chunksMetadata.compressedBytes ||
        (nextCursor !== undefined &&
          nextCursor.length > PUBLIC_SHARE_RELAY_CURSOR_MAX_CHARS) ||
        final !== expectedFinal ||
        (final && nextOffset !== chunksMetadata.compressedBytes) ||
        (!final && nextOffset >= chunksMetadata.compressedBytes) ||
        (final && nextCursor !== undefined) ||
        (!final &&
          (!nextCursor ||
            seenCursors.has(nextCursor) ||
            seenCursors.size >= expectedChunkCount - 1))
      ) {
        throw new Error("Share transfer chunk order or integrity is invalid");
      }

      await transfer(() => writer.write(Uint8Array.from(bytes)));
      expectedOffset = nextOffset;
      expectedIndex += 1;
      if (final) break;
      if (!nextCursor) {
        throw new Error("Share transfer chunk order or integrity is invalid");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (
      expectedIndex !== expectedChunkCount ||
      expectedOffset !== chunksMetadata.compressedBytes
    ) {
      throw new Error("Share transfer chunk order or integrity is invalid");
    }
    await transfer(() => writer.close());
  } catch (error) {
    connection.close(asPublicShareError(error));
    await writer.abort().catch(() => undefined);
    await decodedSessionPromise.catch(() => undefined);
    options.signal?.removeEventListener("abort", abortListener);
    throw error;
  }

  let decodedSession: string;
  try {
    decodedSession = await transfer(() => decodedSessionPromise);
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
  let parsedSession: unknown;
  try {
    parsedSession = JSON.parse(decodedSession) as unknown;
  } catch {
    throw new Error("Share session data is invalid");
  }
  if (!isAppSession(parsedSession)) {
    throw new Error("Share session data is invalid");
  }
  const session: AppSession = parsedSession;
  const response: PublicSessionShareResponse = {
    share: {
      mode: "frozen",
      title: metadata.title,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      capturedAt: chunksMetadata.capturedAt,
      linkedFileMode: chunksMetadata.linkedFileMode,
      source: {
        projectId: session.projectId,
        sessionId: session.id,
        ...(metadata.projectName ? { projectName: metadata.projectName } : {}),
        ...(metadata.provider || session.provider
          ? { provider: metadata.provider ?? session.provider }
          : {}),
      },
    },
    session,
  };
  if (!isPublicSessionShareResponse(response)) {
    throw new Error("Share session data is invalid");
  }
  return response;
}

export async function fetchPublicShareV2ViaRelay(options: {
  relayUrl: string;
  relayUsername: string;
  secret: string;
  viewerId: string;
  signal?: AbortSignal;
  onMetadata?: (metadata: PublicSessionSharePublicMetadata) => void;
}): Promise<{
  metadata: PublicSessionSharePublicMetadata;
  share: PublicSessionShareResponse;
}> {
  const connection = new PublicShareRelayConnection(
    options.relayUrl,
    options.relayUsername,
    options.signal,
  );
  try {
    const metadataParams = new URLSearchParams({ viewerId: options.viewerId });
    const metadata = parseNegotiatedPublicShareMetadata(
      await connection.request(
        `/public-api/shares/${encodeURIComponent(options.secret)}/metadata?${metadataParams}`,
        PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES,
      ),
    );
    if (metadata) options.onMetadata?.(metadata);
    const supportsChunks =
      metadata !== null &&
      typeof globalThis.DecompressionStream === "function" &&
      Array.isArray(metadata.capabilities) &&
      metadata.capabilities.includes(PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY);
    if (supportsChunks) {
      return {
        metadata,
        share: await fetchFrozenSessionChunks(connection, options, metadata),
      };
    }
    const share = await fetchRawPublicShareWithConnectionFallback(
      connection,
      options,
    );
    const effectiveMetadata =
      metadata ?? metadataFromPublicShareResponse(share);
    if (!metadata) options.onMetadata?.(effectiveMetadata);
    return { metadata: effectiveMetadata, share };
  } finally {
    connection.close();
  }
}
