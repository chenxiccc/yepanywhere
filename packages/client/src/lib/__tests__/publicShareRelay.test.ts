// @vitest-environment jsdom

import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  type AppSession,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareResponse,
  type RelayResponse,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicShareMetadataViaRelay,
  fetchPublicShareV2ViaRelay,
  fetchPublicShareViaRelay,
} from "../publicShareRelay";

interface SentRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static onRequest: (socket: FakeWebSocket, request: SentRequest) => void;
  static outstandingRequests = 0;
  static maxOutstandingRequests = 0;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly requests: SentRequest[] = [];
  closed = false;
  readyState = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "client_connect") {
      queueMicrotask(() => this.emit({ type: "client_connected" }));
      return;
    }
    const request = message as SentRequest;
    this.requests.push(request);
    FakeWebSocket.outstandingRequests += 1;
    FakeWebSocket.maxOutstandingRequests = Math.max(
      FakeWebSocket.maxOutstandingRequests,
      FakeWebSocket.outstandingRequests,
    );
    FakeWebSocket.onRequest(this, request);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(message: unknown): void {
    this.emitData(JSON.stringify(message));
  }

  emitData(data: MessageEvent["data"]): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  respond(request: SentRequest, response: Omit<RelayResponse, "id" | "type">) {
    queueMicrotask(() => {
      FakeWebSocket.outstandingRequests -= 1;
      this.emit({ type: "response", id: request.id, ...response });
    });
  }

  respondAndClose(
    request: SentRequest,
    response: Omit<RelayResponse, "id" | "type">,
  ): void {
    this.respond(request, response);
    queueMicrotask(() => this.remoteClose());
  }
}

const session: AppSession = {
  id: "session-1",
  projectId: toUrlProjectId("/repo"),
  projectName: "repo",
  title: "Shared session",
  fullTitle: "Shared session",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:01:00.000Z",
  messageCount: 1,
  ownership: { owner: "none" },
  provider: "claude",
  messages: [
    {
      type: "user",
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "session-1",
      version: "2.1.0",
      uuid: "00000000-0000-4000-8000-000000000001",
      parentUuid: null,
      message: { role: "user", content: "split UTF-8: λ" },
      timestamp: "2026-08-06T00:00:00.000Z",
    },
  ],
};

function sessionWithRandomContent(bytes: number): AppSession {
  const content = randomBytes(bytes).toString("base64");
  return {
    ...session,
    messages: [
      {
        ...session.messages[0]!,
        message: { role: "user", content },
      },
    ],
  } as AppSession;
}

const rawShare: PublicSessionShareResponse = {
  share: {
    mode: "frozen",
    title: "Shared session",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
    capturedAt: "2026-08-06T00:01:00.000Z",
    linkedFileMode: "cow",
    source: {
      projectId: session.projectId,
      sessionId: session.id,
      projectName: "repo",
      provider: "claude",
    },
  },
  session,
};

function metadataFor(
  compressedBytes: number,
  sourceSession: AppSession = session,
): PublicSessionSharePublicMetadata {
  return {
    mode: "frozen",
    title: "Shared session",
    initialPrompt: "hello",
    projectName: "repo",
    provider: "claude",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
    capturedAt: "2026-08-06T00:01:00.000Z",
    linkedFileMode: "cow",
    capabilities: [PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY],
    sessionChunks: {
      revisionId: "revision-1",
      integrityWitness: "witness-1",
      compressedBytes,
      sessionBytes: new TextEncoder().encode(JSON.stringify(sourceSession))
        .byteLength,
      maxChunkBytes: PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      capturedAt: "2026-08-06T00:01:00.000Z",
      linkedFileMode: "cow",
    },
  };
}

function jsonResponse(body: unknown): Omit<RelayResponse, "id" | "type"> {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
  };
}

function chunkResponse(
  bytes: Uint8Array,
  options: {
    final: boolean;
    index: number;
    offset: number;
    total: number;
    cursor?: string;
    revision?: string;
  },
): Omit<RelayResponse, "id" | "type"> {
  return {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-yep-public-share-chunk-index": String(options.index),
      "x-yep-public-share-chunk-offset": String(options.offset),
      "x-yep-public-share-compressed-bytes": String(options.total),
      "x-yep-public-share-final": options.final ? "true" : "false",
      "x-yep-public-share-integrity": "witness-1",
      "x-yep-public-share-next-offset": String(
        options.offset + bytes.byteLength,
      ),
      "x-yep-public-share-revision": options.revision ?? "revision-1",
      ...(options.cursor
        ? { "x-yep-public-share-next-cursor": options.cursor }
        : {}),
    },
    body: {
      _binary: true,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

interface ChunkMutation {
  index?: number;
  offset?: number;
  revision?: string;
  totalDelta?: number;
}

const INVALID_CHUNK_CASES: Array<[string, ChunkMutation]> = [
  ["skipped", { index: 1 }],
  ["reordered", { offset: 1 }],
  ["mismatched", { revision: "other-revision" }],
  ["truncated", { totalDelta: 1 }],
];

describe("publicShareRelay bounded frozen transport", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.outstandingRequests = 0;
    FakeWebSocket.maxOutstandingRequests = 0;
    vi.useRealTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("pulls ordered gzip chunks sequentially over one socket", async () => {
    const chunkedSession = sessionWithRandomContent(400_000);
    const compressed = Uint8Array.from(
      gzipSync(JSON.stringify(chunkedSession)),
    );
    const chunks = [
      compressed.subarray(0, PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
      compressed.subarray(PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
    ];
    expect(chunks[1]!.byteLength).toBeGreaterThan(0);
    expect(chunks[1]!.byteLength).toBeLessThanOrEqual(
      PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
    );
    const metadata = metadataFor(compressed.byteLength, chunkedSession);
    metadata.mode = "live";

    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      const url = new URL(request.path, "https://server.invalid");
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        socket.respond(
          request,
          chunkResponse(chunks[0]!, {
            final: false,
            index: 0,
            offset: 0,
            total: compressed.byteLength,
            cursor: "opaque-next",
          }),
        );
      } else {
        expect(cursor).toBe("opaque-next");
        socket.respond(
          request,
          chunkResponse(chunks[1]!, {
            final: true,
            index: 1,
            offset: chunks[0]!.byteLength,
            total: compressed.byteLength,
          }),
        );
      }
    };

    const onMetadata = vi.fn();
    const result = await fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
      onMetadata,
    });

    expect(onMetadata).toHaveBeenCalledWith(metadata);
    expect(result.share.session).toEqual(chunkedSession);
    expect(result.share.share).toMatchObject({
      mode: "frozen",
      capturedAt: metadata.sessionChunks?.capturedAt,
      source: { projectId: session.projectId, sessionId: session.id },
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual([
      "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
      "/public-api/shares/bearer-secret/session-chunks?viewerId=viewer-1234",
      "/public-api/shares/bearer-secret/session-chunks?viewerId=viewer-1234&cursor=opaque-next",
    ]);
    expect(FakeWebSocket.maxOutstandingRequests).toBe(1);
  });

  it("fails promptly when the socket closes between capable chunks", async () => {
    const chunkedSession = sessionWithRandomContent(400_000);
    const compressed = Uint8Array.from(
      gzipSync(JSON.stringify(chunkedSession)),
    );
    const metadata = metadataFor(compressed.byteLength, chunkedSession);
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      socket.respondAndClose(
        request,
        chunkResponse(
          compressed.subarray(0, PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
          {
            final: false,
            index: 0,
            offset: 0,
            total: compressed.byteLength,
            cursor: "next-chunk",
          },
        ),
      );
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("Relay connection closed");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(2);
  });

  it.each([
    ["unsafe compressed size", "compressedBytes", Number.MAX_SAFE_INTEGER + 1],
    [
      "over-limit compressed size",
      "compressedBytes",
      PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES + 1,
    ],
    ["unsafe decompressed size", "sessionBytes", Number.MAX_SAFE_INTEGER + 1],
    [
      "over-limit decompressed size",
      "sessionBytes",
      PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES + 1,
    ],
    [
      "wrong fixed chunk size",
      "maxChunkBytes",
      PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES - 1,
    ],
  ] as const)(
    "rejects %s before decompressor construction or a chunk pull",
    async (_name, field, value) => {
      const metadata = metadataFor(100);
      metadata.sessionChunks![field] = value;
      let decompressorConstructions = 0;
      vi.stubGlobal(
        "DecompressionStream",
        class {
          constructor() {
            decompressorConstructions += 1;
          }
        },
      );
      FakeWebSocket.onRequest = (socket, request) => {
        socket.respond(request, jsonResponse(metadata));
      };
      const onMetadata = vi.fn();

      await expect(
        fetchPublicShareV2ViaRelay({
          relayUrl: "wss://relay.invalid/ws",
          relayUsername: "host",
          secret: "bearer-secret",
          viewerId: "viewer-1234",
          onMetadata,
        }),
      ).rejects.toThrow(/metadata/i);

      expect(decompressorConstructions).toBe(0);
      expect(onMetadata).not.toHaveBeenCalled();
      expect(
        FakeWebSocket.instances[0]!.requests.map((request) => request.path),
      ).toEqual([
        "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
      ]);
    },
  );

  it("uses exactly the raw-json fallback when metadata lacks the capability", async () => {
    const metadata = metadataFor(10);
    delete metadata.capabilities;
    delete metadata.sessionChunks;
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        jsonResponse(request.path.includes("/metadata?") ? metadata : rawShare),
      );
    };

    const result = await fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
    });

    expect(result.share).toEqual(rawShare);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual([
      "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
      "/public-api/shares/bearer-secret?viewerId=viewer-1234&wire=raw-json",
    ]);
  });

  it("uses raw-json when the metadata route is missing", async () => {
    const metadataResponse = { status: 404, body: { error: "Not found" } };
    const onMetadata = vi.fn();
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        request.path.includes("/metadata?")
          ? {
              status: metadataResponse.status,
              headers: { "content-type": "application/json" },
              body: metadataResponse.body,
            }
          : jsonResponse(rawShare),
      );
    };

    const result = await fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
      onMetadata,
    });

    expect(result.share).toEqual(rawShare);
    expect(result.metadata).toMatchObject({
      mode: rawShare.share.mode,
      title: rawShare.share.title,
      projectName: rawShare.share.source.projectName,
    });
    expect(onMetadata).toHaveBeenCalledOnce();
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual([
      "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
      "/public-api/shares/bearer-secret?viewerId=viewer-1234&wire=raw-json",
    ]);
  });

  it("rejects malformed successful metadata without raw fallback", async () => {
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        request.path.includes("/metadata?")
          ? jsonResponse({ mode: "frozen" })
          : jsonResponse(rawShare),
      );
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("Share metadata is invalid");
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual([
      "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
    ]);
  });

  it("opens a fresh socket when a one-response peer closes after metadata", async () => {
    const metadata = metadataFor(10);
    delete metadata.capabilities;
    delete metadata.sessionChunks;
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respondAndClose(request, jsonResponse(metadata));
        return;
      }
      socket.respond(request, jsonResponse(rawShare));
    };

    const result = await fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
    });

    expect(result.share).toEqual(rawShare);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(1);
    expect(FakeWebSocket.instances[1]!.requests).toHaveLength(1);
  });

  it("uses the raw-json fallback when gzip streaming is unavailable", async () => {
    const compressed = Uint8Array.from(gzipSync(JSON.stringify(session)));
    const metadata = metadataFor(compressed.byteLength);
    vi.stubGlobal("DecompressionStream", undefined);
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        jsonResponse(request.path.includes("/metadata?") ? metadata : rawShare),
      );
    };

    const result = await fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
    });

    expect(result.share).toEqual(rawShare);
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual([
      "/public-api/shares/bearer-secret/metadata?viewerId=viewer-1234",
      "/public-api/shares/bearer-secret?viewerId=viewer-1234&wire=raw-json",
    ]);
  });

  it("keeps unmarked links on the existing combined request", async () => {
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(request, jsonResponse(rawShare));
    };

    await fetchPublicShareViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      FakeWebSocket.instances[0]!.requests.map((request) => request.path),
    ).toEqual(["/public-api/shares/bearer-secret?viewerId=viewer-1234"]);
  });

  it("rejects malformed metadata before publishing or requesting a body", async () => {
    const metadata = { ...metadataFor(100), mode: "invalid" };
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(request, jsonResponse(metadata));
    };
    const onMetadata = vi.fn();

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
        onMetadata,
      }),
    ).rejects.toThrow("Share metadata is invalid");

    expect(onMetadata).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(1);
  });

  it("rejects an unexpected metadata success status before fallback", async () => {
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        request.path.includes("/metadata?")
          ? { ...jsonResponse(metadataFor(100)), status: 204 }
          : jsonResponse(rawShare),
      );
    };
    const onMetadata = vi.fn();

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
        onMetadata,
      }),
    ).rejects.toMatchObject({ status: 204, retryable: false });
    expect(onMetadata).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(1);
  });

  it("rejects unexpected combined and chunk success statuses", async () => {
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(request, { ...jsonResponse(rawShare), status: 206 });
    };
    await expect(
      fetchPublicShareViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "unmarked-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toMatchObject({ status: 206, retryable: false });

    const compressed = Uint8Array.from(gzipSync(JSON.stringify(session)));
    const metadata = metadataFor(compressed.byteLength);
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      socket.respond(request, {
        ...chunkResponse(compressed, {
          final: true,
          index: 0,
          offset: 0,
          total: compressed.byteLength,
        }),
        status: 206,
      });
    };
    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "marked-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toMatchObject({ status: 206, retryable: false });
  });

  it("rejects malformed marked and unmarked combined responses", async () => {
    const metadata = metadataFor(10);
    delete metadata.capabilities;
    delete metadata.sessionChunks;
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(
        request,
        jsonResponse(request.path.includes("/metadata?") ? metadata : {}),
      );
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "marked-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("Share response is invalid");
    await expect(
      fetchPublicShareViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "unmarked-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("Share response is invalid");
  });

  it("uses the metadata validator in the standalone helper", async () => {
    FakeWebSocket.onRequest = (socket, request) => {
      socket.respond(request, jsonResponse({ mode: "frozen" }));
    };

    await expect(
      fetchPublicShareMetadataViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
      }),
    ).rejects.toThrow("Share metadata is invalid");
  });

  it.each([
    ["invalid identity", { ...session, projectId: 42 }],
    [
      "malformed nested content",
      {
        ...session,
        messages: [
          {
            type: "user",
            message: { role: "user", content: [null] },
          },
        ],
      },
    ],
    [
      "an unknown message discriminator",
      {
        ...session,
        messages: [{ type: "definitely-not-an-app-message" }],
      },
    ],
    [
      "an incomplete system message",
      { ...session, messages: [{ type: "system" }] },
    ],
    [
      "an incomplete summary message",
      { ...session, messages: [{ type: "summary", summary: "Recap" }] },
    ],
  ])(
    "rejects a decompressed session with %s",
    async (_label, invalidSession) => {
      const serialized = JSON.stringify(invalidSession);
      const compressed = Uint8Array.from(gzipSync(serialized));
      const metadata = metadataFor(compressed.byteLength);
      metadata.sessionChunks!.sessionBytes = new TextEncoder().encode(
        serialized,
      ).byteLength;
      FakeWebSocket.onRequest = (socket, request) => {
        if (request.path.includes("/metadata?")) {
          socket.respond(request, jsonResponse(metadata));
          return;
        }
        socket.respond(
          request,
          chunkResponse(compressed, {
            final: true,
            index: 0,
            offset: 0,
            total: compressed.byteLength,
          }),
        );
      };

      await expect(
        fetchPublicShareV2ViaRelay({
          relayUrl: "wss://relay.invalid/ws",
          relayUsername: "host",
          secret: "bearer-secret",
          viewerId: "viewer-1234",
        }),
      ).rejects.toThrow("Share session data is invalid");
    },
  );

  it("rejects a duplicated next cursor before accepting another chunk", async () => {
    const chunkedSession = sessionWithRandomContent(800_000);
    const compressed = Uint8Array.from(
      gzipSync(JSON.stringify(chunkedSession)),
    );
    expect(compressed.byteLength).toBeGreaterThan(
      2 * PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
    );
    const chunks = [
      compressed.subarray(0, PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
      compressed.subarray(
        PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
        2 * PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      ),
    ];
    const metadata = metadataFor(compressed.byteLength, chunkedSession);
    let chunkIndex = 0;
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      const bytes = chunks[chunkIndex]!;
      socket.respond(
        request,
        chunkResponse(bytes, {
          final: false,
          index: chunkIndex,
          offset: chunkIndex * PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
          total: compressed.byteLength,
          cursor: "duplicated-cursor",
        }),
      );
      chunkIndex += 1;
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow(/order or integrity/);
    expect(chunkIndex).toBe(2);
  });

  it("rejects an oversized cursor before constructing another request", async () => {
    const chunkedSession = sessionWithRandomContent(400_000);
    const compressed = Uint8Array.from(
      gzipSync(JSON.stringify(chunkedSession)),
    );
    const metadata = metadataFor(compressed.byteLength, chunkedSession);
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      socket.respond(
        request,
        chunkResponse(
          compressed.subarray(0, PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES),
          {
            final: false,
            index: 0,
            offset: 0,
            total: compressed.byteLength,
            cursor: "x".repeat(1025),
          },
        ),
      );
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow(/order or integrity/);
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(2);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it.each(["string", "blob"] as const)(
    "rejects an oversized %s frame before parsing it",
    async (kind) => {
      FakeWebSocket.onRequest = (socket) => {
        const oversizedBytes = 128 * 1024 + 1;
        queueMicrotask(() => {
          socket.emitData(
            kind === "string"
              ? "x".repeat(oversizedBytes)
              : new Blob([new Uint8Array(oversizedBytes)]),
          );
        });
      };

      await expect(
        fetchPublicShareV2ViaRelay({
          relayUrl: "wss://relay.invalid/ws",
          relayUsername: "host",
          secret: "bearer-secret",
          viewerId: "viewer-1234",
        }),
      ).rejects.toThrow("Relay response is too large");
      expect(FakeWebSocket.instances[0]!.closed).toBe(true);
      expect(FakeWebSocket.instances[0]!.requests).toHaveLength(1);
    },
  );

  it("rejects when the relay disconnects during a transfer", async () => {
    FakeWebSocket.onRequest = (socket) => {
      queueMicrotask(() => socket.onclose?.());
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("Relay connection closed");
  });

  it("aborts an in-flight chunk pull and closes its socket", async () => {
    const compressed = Uint8Array.from(gzipSync(JSON.stringify(session)));
    const metadata = metadataFor(compressed.byteLength);
    const abortController = new AbortController();
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
      }
    };

    const result = fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
      signal: abortController.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances[0]?.requests).toHaveLength(2);
    });
    abortController.abort();

    await rejection;
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(2);
  });

  it("cancels decompression when aborted during the final drain", async () => {
    const encodedSession = new TextEncoder().encode(JSON.stringify(session));
    const compressed = Uint8Array.of(1);
    const metadata = metadataFor(compressed.byteLength);
    const abortController = new AbortController();
    let readableController!: ReadableStreamDefaultController<Uint8Array>;
    let readableCancelled = false;
    let writableClosed = false;
    vi.stubGlobal(
      "DecompressionStream",
      class {
        readonly readable = new ReadableStream<Uint8Array>({
          start(controller) {
            readableController = controller;
          },
          cancel() {
            readableCancelled = true;
          },
        });
        readonly writable = new WritableStream<Uint8Array>({
          write() {
            readableController.enqueue(encodedSession);
          },
          close() {
            writableClosed = true;
          },
        });
      },
    );
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      socket.respond(
        request,
        chunkResponse(compressed, {
          final: true,
          index: 0,
          offset: 0,
          total: compressed.byteLength,
        }),
      );
    };

    const result = fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
      signal: abortController.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(writableClosed).toBe(true));
    abortController.abort();

    await rejection;
    expect(readableCancelled).toBe(true);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it("stops before another pull when the gzip reader fails", async () => {
    const chunkedSession = sessionWithRandomContent(400_000);
    const compressed = Uint8Array.from(
      gzipSync(JSON.stringify(chunkedSession)),
    );
    const split = PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES;
    const metadata = metadataFor(compressed.byteLength, chunkedSession);
    let readableController!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "DecompressionStream",
      class {
        readonly readable = new ReadableStream<Uint8Array>({
          start(controller) {
            readableController = controller;
          },
        });
        readonly writable = new WritableStream<Uint8Array>({
          write() {
            readableController.error(new Error("gzip reader failed"));
          },
        });
      },
    );
    FakeWebSocket.onRequest = (socket, request) => {
      if (request.path.includes("/metadata?")) {
        socket.respond(request, jsonResponse(metadata));
        return;
      }
      socket.respond(
        request,
        chunkResponse(compressed.subarray(0, split), {
          final: false,
          index: 0,
          offset: 0,
          total: compressed.byteLength,
          cursor: "must-not-be-used",
        }),
      );
    };

    await expect(
      fetchPublicShareV2ViaRelay({
        relayUrl: "wss://relay.invalid/ws",
        relayUsername: "host",
        secret: "bearer-secret",
        viewerId: "viewer-1234",
      }),
    ).rejects.toThrow("gzip reader failed");
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(FakeWebSocket.instances[0]!.requests).toHaveLength(2);
  });

  it("closes and rejects a timed-out share request", async () => {
    vi.useFakeTimers();
    FakeWebSocket.onRequest = () => undefined;
    const result = fetchPublicShareV2ViaRelay({
      relayUrl: "wss://relay.invalid/ws",
      relayUsername: "host",
      secret: "bearer-secret",
      viewerId: "viewer-1234",
    });
    const rejection = expect(result).rejects.toThrow("Share request timed out");
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  it.each(INVALID_CHUNK_CASES)(
    "rejects %s chunk sequences",
    async (_name, mutation) => {
      const compressed = Uint8Array.from(gzipSync(JSON.stringify(session)));
      const metadata = metadataFor(
        compressed.byteLength + (mutation.totalDelta ?? 0),
      );
      FakeWebSocket.onRequest = (socket, request) => {
        if (request.path.includes("/metadata?")) {
          socket.respond(request, jsonResponse(metadata));
          return;
        }
        socket.respond(
          request,
          chunkResponse(compressed, {
            final: true,
            index: mutation.index ?? 0,
            offset: mutation.offset ?? 0,
            total: metadata.sessionChunks!.compressedBytes,
            revision: mutation.revision,
          }),
        );
      };

      await expect(
        fetchPublicShareV2ViaRelay({
          relayUrl: "wss://relay.invalid/ws",
          relayUsername: "host",
          secret: "bearer-secret",
          viewerId: "viewer-1234",
        }),
      ).rejects.toThrow(/transfer/);
      expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    },
  );
});
