import type {
  RelayRequest,
  RemoteClientMessage,
  UploadedFile,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayProtocol, type RelayTransport } from "../RelayProtocol";

function testFile(name: string, body: string, type: string): File {
  const bytes = new TextEncoder().encode(body);
  return {
    name,
    type,
    size: bytes.byteLength,
    stream() {
      let sent = false;
      return {
        getReader() {
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
            cancel: vi.fn(),
          };
        },
      };
    },
  } as unknown as File;
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for async protocol work");
}

describe("RelayProtocol hooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports inbound relay events before consumer routing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onInboundEvent = vi.fn();
    const protocol = new RelayProtocol(
      {
        sendMessage: vi.fn(),
        sendUploadChunk: vi.fn(),
        ensureConnected: vi.fn(async () => undefined),
        isConnected: vi.fn(() => true),
      },
      { onInboundEvent },
    );

    protocol.routeMessage({
      type: "event",
      subscriptionId: "missing-subscription",
      eventType: "heartbeat",
      data: null,
    });

    expect(onInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "heartbeat" }),
    );
  });

  it("uses injected critical-operation guards for uploads", async () => {
    const sent: RemoteClientMessage[] = [];
    const endCriticalOperation = vi.fn();
    const beginCriticalOperation = vi.fn(() => endCriticalOperation);
    const transport: RelayTransport = {
      sendMessage: (msg) => {
        sent.push(msg);
      },
      sendUploadChunk: vi.fn(async () => undefined),
      ensureConnected: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
    };
    const protocol = new RelayProtocol(transport, {
      beginCriticalOperation,
    });
    const uploadedFile: UploadedFile = {
      id: "file-1",
      name: "file-1_note.txt",
      originalName: "note.txt",
      path: "/uploads/file-1_note.txt",
      size: 4,
      mimeType: "text/plain",
    };

    const uploadPromise = protocol.upload(
      "project-1",
      "session-1",
      testFile("note.txt", "note", "text/plain"),
    );

    await flushUntil(() => sent.some((msg) => msg.type === "upload_end"));
    const uploadStart = sent.find(
      (msg): msg is Extract<RemoteClientMessage, { type: "upload_start" }> =>
        msg.type === "upload_start",
    );
    expect(uploadStart).toBeDefined();
    if (!uploadStart) throw new Error("Expected upload_start");

    protocol.routeMessage({
      type: "upload_complete",
      uploadId: uploadStart.uploadId,
      file: uploadedFile,
    });

    await expect(uploadPromise).resolves.toEqual(uploadedFile);
    expect(beginCriticalOperation).toHaveBeenCalledWith("upload");
    expect(endCriticalOperation).toHaveBeenCalledTimes(1);
    expect(transport.sendUploadChunk).toHaveBeenCalledTimes(1);
    expect(
      sent.find((msg) => msg.type === "request") as RelayRequest | undefined,
    ).toBeUndefined();
  });

  it("follows same-server API redirects", async () => {
    const sent: RemoteClientMessage[] = [];
    const protocol = new RelayProtocol({
      sendMessage: (message) => sent.push(message),
      sendUploadChunk: vi.fn(),
      ensureConnected: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
    });

    const fetchPromise = protocol.fetch<{ messages: unknown[] }>(
      "/sessions/session-1?projectId=wrong-project",
    );
    await flushUntil(() => sent.length === 1);
    const first = sent[0] as RelayRequest;
    protocol.routeMessage({
      type: "response",
      id: first.id,
      status: 307,
      headers: {
        Location: "/api/sessions/session-1?projectId=correct-project",
      },
      body: null,
    });

    await flushUntil(() => sent.length === 2);
    const redirected = sent[1] as RelayRequest;
    expect(redirected.path).toBe(
      "/api/sessions/session-1?projectId=correct-project",
    );
    protocol.routeMessage({
      type: "response",
      id: redirected.id,
      status: 200,
      body: { messages: [] },
    });

    await expect(fetchPromise).resolves.toEqual({ messages: [] });
  });
});
