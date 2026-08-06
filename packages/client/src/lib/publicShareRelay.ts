import {
  PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT,
  isAppSession,
  isPublicShareSessionChunksMetadata,
  isPublicSessionSharePublicMetadata,
  isPublicSessionShareResponse,
  type AppSession,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareResponse,
  type PublicShareSessionChunksMetadata,
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

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function decodeWebSocketData(
  data: MessageEvent["data"],
  maxBytes: number,
): Promise<string> {
  if (typeof data === "string") {
    if (data.length > maxBytes) {
      throw new Error("Relay response is too large");
    }
    return data;
  }
  if (data instanceof Blob) {
    if (data.size > maxBytes) {
      throw new Error("Relay response is too large");
    }
    const text = await data.text();
    if (text.length > maxBytes) {
      throw new Error("Relay response is too large");
    }
    return text;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxBytes) {
      throw new Error("Relay response is too large");
    }
    const text = new TextDecoder().decode(data);
    if (text.length > maxBytes) {
      throw new Error("Relay response is too large");
    }
    return text;
  }
  throw new Error("Relay returned an invalid response");
}

export interface PublicShareRelayRequestOptions {
  path: string;
  relayUrl: string;
  relayUsername: string;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

const PUBLIC_SHARE_RELAY_TIMEOUT_MS = 30_000;
const PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES = 128 * 1024;
const PUBLIC_SHARE_RELAY_CHUNK_FRAME_MAX_BYTES = 512 * 1024;
const PUBLIC_SHARE_RELAY_HEADER_MAX_COUNT = 64;
const PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS = 128;
const PUBLIC_SHARE_RELAY_HEADER_VALUE_MAX_CHARS = 4096;
const PUBLIC_SHARE_RELAY_CURSOR_MAX_CHARS = 1024;

function publicShareAbortError(): Error {
  const error = new Error("Share request cancelled");
  error.name = "AbortError";
  return error;
}

function asPublicShareError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Share transfer failed");
}

function hasBoundedRelayResponseHeaders(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= PUBLIC_SHARE_RELAY_HEADER_MAX_COUNT &&
    entries.every(
      ([name, headerValue]) =>
        name.length <= PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS &&
        typeof headerValue === "string" &&
        headerValue.length <= PUBLIC_SHARE_RELAY_HEADER_VALUE_MAX_CHARS,
    )
  );
}

class PublicShareRelayConnection {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;
  private connectTimeout: ReturnType<typeof setTimeout> | null;
  private pending:
    | {
        id: string;
        resolve: (response: RelayResponse) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
        maxResponseBytes: number;
      }
    | undefined;
  private closedIntentionally = false;
  private terminalError: Error | undefined;
  private readonly signal?: AbortSignal;
  private readonly abortListener = () => {
    this.close(publicShareAbortError());
  };

  constructor(relayUrl: string, relayUsername: string, signal?: AbortSignal) {
    this.signal = signal;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.ready.catch(() => undefined);
    this.ws = new WebSocket(relayUrl);
    this.connectTimeout = setTimeout(() => {
      this.fail(new Error("Share request timed out"));
      this.close();
    }, PUBLIC_SHARE_RELAY_TIMEOUT_MS);

    this.ws.onopen = () => {
      this.ws.send(
        JSON.stringify({ type: "client_connect", username: relayUsername }),
      );
    };
    this.ws.onmessage = (event) => {
      void this.handleMessage(event);
    };
    this.ws.onerror = () => {
      this.close(new Error("Relay connection failed"));
    };
    this.ws.onclose = () => {
      if (!this.closedIntentionally) {
        this.failTerminal(new Error("Relay connection closed"));
      }
    };
    this.signal?.addEventListener("abort", this.abortListener, { once: true });
    if (this.signal?.aborted) {
      this.abortListener();
    }
  }

  async request(
    path: string,
    maxResponseBytes = PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  ): Promise<RelayResponse> {
    await this.ready;
    if (this.signal?.aborted) throw publicShareAbortError();
    if (this.terminalError) throw this.terminalError;
    if (this.closedIntentionally || this.ws.readyState >= 2) {
      throw new Error("Relay connection closed");
    }
    if (this.pending) {
      throw new Error("Public share relay requests must be sequential");
    }

    const id = generateRequestId();
    return await new Promise<RelayResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        const error = new Error("Share request timed out");
        reject(error);
        this.close(error);
      }, PUBLIC_SHARE_RELAY_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timeout, maxResponseBytes };
      try {
        this.ws.send(
          JSON.stringify({
            type: "request",
            id,
            method: "GET",
            path,
            headers: {},
          }),
        );
      } catch {
        clearTimeout(timeout);
        this.pending = undefined;
        const terminalError = new Error("Relay connection closed");
        this.failTerminal(terminalError);
        reject(terminalError);
      }
    });
  }

  isTerminal(): boolean {
    return (
      this.terminalError !== undefined ||
      this.closedIntentionally ||
      this.ws.readyState >= 2
    );
  }

  close(error = new Error("Relay connection closed")): void {
    if (this.closedIntentionally) return;
    this.failTerminal(error);
    this.closedIntentionally = true;
    this.signal?.removeEventListener("abort", this.abortListener);
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    this.ws.close();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    let message: unknown;
    try {
      const maxResponseBytes =
        this.pending?.maxResponseBytes ??
        PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES;
      let text: string;
      if (typeof event.data === "string") {
        if (event.data.length > maxResponseBytes) {
          throw new Error("Relay response is too large");
        }
        text = event.data;
      } else {
        text = await decodeWebSocketData(event.data, maxResponseBytes);
      }
      message = JSON.parse(text) as unknown;
    } catch (error) {
      const responseError = asPublicShareError(error);
      this.fail(responseError);
      this.close(responseError);
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "client_connected"
    ) {
      if (!this.readySettled) {
        this.readySettled = true;
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.readyResolve();
      }
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "response"
    ) {
      const response = message as RelayResponse;
      if (
        typeof response.id !== "string" ||
        response.id.length > PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        !hasBoundedRelayResponseHeaders(response.headers)
      ) {
        const error = new Error("Relay returned an invalid response");
        this.fail(error);
        this.close(error);
        return;
      }
      if (!this.pending || response.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timeout);
      pending.resolve(response);
    }
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.readyReject(error);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failTerminal(error: Error): void {
    this.terminalError ??= error;
    this.fail(this.terminalError);
  }
}

export async function fetchPublicShareRelayResponse({
  path,
  relayUrl,
  relayUsername,
  signal,
  maxResponseBytes,
}: PublicShareRelayRequestOptions): Promise<RelayResponse> {
  const connection = new PublicShareRelayConnection(
    relayUrl,
    relayUsername,
    signal,
  );
  try {
    return await connection.request(path, maxResponseBytes);
  } finally {
    connection.close();
  }
}

function parsePublicShareJsonResponse(response: RelayResponse): unknown {
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

function parsePublicShareMetadataResponse(
  response: RelayResponse,
): PublicSessionSharePublicMetadata {
  const body = parsePublicShareJsonResponse(response);
  if (!isPublicSessionSharePublicMetadata(body)) {
    throw new Error("Share metadata is invalid");
  }
  return body;
}

function parseNegotiatedPublicShareMetadata(
  response: RelayResponse,
): PublicSessionSharePublicMetadata | null {
  if (response.status === 404) return null;
  return parsePublicShareMetadataResponse(response);
}

function metadataFromPublicShareResponse(
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

function parsePublicShareResponse(
  response: RelayResponse,
): PublicSessionShareResponse {
  const body = parsePublicShareJsonResponse(response);
  if (!isPublicSessionShareResponse(body)) {
    throw new Error("Share response is invalid");
  }
  return body;
}

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

function buildPublicShareSessionPath(options: {
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
