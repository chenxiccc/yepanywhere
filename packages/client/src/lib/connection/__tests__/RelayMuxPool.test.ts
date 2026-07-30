import {
  RELAY_CLIENT_MUX_V1_CAPABILITY,
  decodeRelayMuxDataFrame,
  encodeRelayMuxDataFrame,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SavedHost } from "../../hostStorage";
import {
  RelayMuxCircuitOpenError,
  RelayMuxSocketPool,
} from "../RelayMuxPool";
import type { SecureConnectionSocket } from "../SecureConnectionSocket";

class FakePhysicalWebSocket {
  static instances: FakePhysicalWebSocket[] = [];

  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];

  constructor(readonly url: string) {
    FakePhysicalWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
      return;
    }
    this.sent.push(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  receiveControl(message: object): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  receiveData(
    circuitId: number,
    payload: Uint8Array,
    isBinary: boolean,
  ): void {
    const frame = encodeRelayMuxDataFrame(circuitId, payload, isBinary);
    this.onmessage?.(
      new MessageEvent("message", {
        data: frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
        ),
      }),
    );
  }
}

function savedHost(id: string): SavedHost {
  return {
    id,
    displayName: id,
    mode: "relay",
    relayUrl: "wss://relay.example/ws",
    relayUsername: id,
    srpUsername: id,
    session: {
      wsUrl: "wss://relay.example/ws",
      username: id,
      sessionId: `session-${id}`,
      sessionKey: "key",
      resumeProtocolVersion: 3,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function muxFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "ok",
        relayCapabilities: [RELAY_CLIENT_MUX_V1_CAPABILITY],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  ) as typeof fetch;
}

function textControls(ws: FakePhysicalWebSocket): Array<Record<string, unknown>> {
  return ws.sent.flatMap((data) =>
    typeof data === "string"
      ? [JSON.parse(data) as Record<string, unknown>]
      : [],
  );
}

describe("RelayMuxSocketPool", () => {
  it("opens two independently routed logical sockets over one physical mux", async () => {
    FakePhysicalWebSocket.instances = [];
    const hosts = [savedHost("alpha"), savedHost("beta")];
    const openLegacySocket = vi.fn();
    const pool = new RelayMuxSocketPool(hosts, {
      createWebSocket: (url) =>
        new FakePhysicalWebSocket(url) as unknown as WebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });

    const alphaPromise = pool.createSocketFactory(hosts[0]!)({
      relayUrl: hosts[0]!.relayUrl!,
      relayUsername: "alpha",
    });
    const betaPromise = pool.createSocketFactory(hosts[1]!)({
      relayUrl: hosts[1]!.relayUrl!,
      relayUsername: "beta",
    });

    await vi.waitFor(() =>
      expect(FakePhysicalWebSocket.instances).toHaveLength(1),
    );
    const physical = FakePhysicalWebSocket.instances[0]!;
    expect(physical.url).toBe("wss://relay.example/mux");
    physical.open();
    physical.receiveControl({
      type: "mux_ready",
      protocolVersion: 1,
      maxCircuits: 5,
      maxFrameBytes: 2 * 1024 * 1024,
    });

    await vi.waitFor(() =>
      expect(
        textControls(physical).filter((message) => message.type === "mux_open"),
      ).toHaveLength(2),
    );
    const opens = textControls(physical).filter(
      (message) => message.type === "mux_open",
    );
    const alphaOpen = opens.find((message) => message.username === "alpha");
    const betaOpen = opens.find((message) => message.username === "beta");
    physical.receiveControl({
      type: "mux_opened",
      circuitId: alphaOpen?.circuitId,
    });
    physical.receiveControl({
      type: "mux_opened",
      circuitId: betaOpen?.circuitId,
    });

    const [alpha, beta] = await Promise.all([alphaPromise, betaPromise]);
    expect(alpha.readyState).toBe(WebSocket.OPEN);
    expect(beta.readyState).toBe(WebSocket.OPEN);
    expect(openLegacySocket).not.toHaveBeenCalled();

    alpha.send("hello alpha");
    beta.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() =>
      expect(physical.sent.filter((data) => data instanceof Uint8Array)).toHaveLength(
        2,
      ),
    );
    const dataFrames = physical.sent
      .filter((data): data is Uint8Array => data instanceof Uint8Array)
      .map((data) => decodeRelayMuxDataFrame(data));
    expect(dataFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          circuitId: alphaOpen?.circuitId,
          isBinary: false,
        }),
        expect.objectContaining({
          circuitId: betaOpen?.circuitId,
          isBinary: true,
        }),
      ]),
    );

    const alphaMessage = vi.fn();
    const betaMessage = vi.fn();
    alpha.onmessage = alphaMessage;
    beta.onmessage = betaMessage;
    physical.receiveData(
      alphaOpen?.circuitId as number,
      new TextEncoder().encode("alpha response"),
      false,
    );
    expect(alphaMessage.mock.calls[0]?.[0].data).toBe("alpha response");
    expect(betaMessage).not.toHaveBeenCalled();

    pool.dispose();
    expect(alpha.readyState).toBe(WebSocket.CLOSED);
    expect(beta.readyState).toBe(WebSocket.CLOSED);
  });

  it("uses exact legacy fallback when discovery lacks the capability", async () => {
    const hosts = [savedHost("alpha"), savedHost("beta")];
    const legacy = {
      readyState: WebSocket.OPEN,
    } as SecureConnectionSocket;
    const openLegacySocket = vi.fn(async () => legacy);
    const createWebSocket = vi.fn();
    const pool = new RelayMuxSocketPool(hosts, {
      createWebSocket,
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      ) as typeof fetch,
      openLegacySocket,
    });

    await expect(
      pool.createSocketFactory(hosts[0]!)({
        relayUrl: hosts[0]!.relayUrl!,
        relayUsername: "alpha",
      }),
    ).resolves.toBe(legacy);
    expect(openLegacySocket).toHaveBeenCalledOnce();
    expect(createWebSocket).not.toHaveBeenCalled();
  });

  it("keeps single-host and group-overflow connections on legacy sockets", async () => {
    const legacy = {
      readyState: WebSocket.OPEN,
    } as SecureConnectionSocket;
    const openLegacySocket = vi.fn(async () => legacy);
    const createWebSocket = vi.fn();
    const singleHost = savedHost("single");
    const singlePool = new RelayMuxSocketPool([singleHost], {
      createWebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });

    await expect(
      singlePool.createSocketFactory(singleHost)({
        relayUrl: singleHost.relayUrl!,
        relayUsername: "single",
      }),
    ).resolves.toBe(legacy);

    const groupedHosts = Array.from({ length: 6 }, (_, index) =>
      savedHost(`host-${index + 1}`),
    );
    const groupedPool = new RelayMuxSocketPool(groupedHosts, {
      createWebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });
    await expect(
      groupedPool.createSocketFactory(groupedHosts[5]!)({
        relayUrl: groupedHosts[5]!.relayUrl!,
        relayUsername: groupedHosts[5]!.relayUsername!,
      }),
    ).resolves.toBe(legacy);

    expect(openLegacySocket).toHaveBeenCalledTimes(2);
    expect(createWebSocket).not.toHaveBeenCalled();
    singlePool.dispose();
    groupedPool.dispose();
  });

  it("keeps a circuit-scoped open error out of the legacy fallback path", async () => {
    FakePhysicalWebSocket.instances = [];
    const hosts = [savedHost("alpha"), savedHost("beta")];
    const openLegacySocket = vi.fn();
    const pool = new RelayMuxSocketPool(hosts, {
      createWebSocket: (url) =>
        new FakePhysicalWebSocket(url) as unknown as WebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });

    const opening = pool.createSocketFactory(hosts[0]!)({
      relayUrl: hosts[0]!.relayUrl!,
      relayUsername: "alpha",
    });
    await vi.waitFor(() =>
      expect(FakePhysicalWebSocket.instances).toHaveLength(1),
    );
    const physical = FakePhysicalWebSocket.instances[0]!;
    physical.open();
    physical.receiveControl({
      type: "mux_ready",
      protocolVersion: 1,
      maxCircuits: 5,
      maxFrameBytes: 1024,
    });
    await vi.waitFor(() =>
      expect(
        textControls(physical).some((message) => message.type === "mux_open"),
      ).toBe(true),
    );
    const open = textControls(physical).find(
      (message) => message.type === "mux_open",
    );
    physical.receiveControl({
      type: "mux_error",
      circuitId: open?.circuitId,
      reason: "server_offline",
    });

    await expect(opening).rejects.toEqual(
      new RelayMuxCircuitOpenError("server_offline"),
    );
    expect(openLegacySocket).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("deduplicates a new mux connection after physical socket loss", async () => {
    FakePhysicalWebSocket.instances = [];
    const hosts = [savedHost("alpha"), savedHost("beta")];
    const openLegacySocket = vi.fn();
    const pool = new RelayMuxSocketPool(hosts, {
      createWebSocket: (url) =>
        new FakePhysicalWebSocket(url) as unknown as WebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });
    const openPair = async (expectedPhysicalCount: number) => {
      const alphaPromise = pool.createSocketFactory(hosts[0]!)({
        relayUrl: hosts[0]!.relayUrl!,
        relayUsername: "alpha",
      });
      const betaPromise = pool.createSocketFactory(hosts[1]!)({
        relayUrl: hosts[1]!.relayUrl!,
        relayUsername: "beta",
      });
      await vi.waitFor(() =>
        expect(FakePhysicalWebSocket.instances).toHaveLength(
          expectedPhysicalCount,
        ),
      );
      const physical = FakePhysicalWebSocket.instances.at(-1)!;
      physical.open();
      physical.receiveControl({
        type: "mux_ready",
        protocolVersion: 1,
        maxCircuits: 5,
        maxFrameBytes: 1024,
      });
      await vi.waitFor(() =>
        expect(
          textControls(physical).filter(
            (message) => message.type === "mux_open",
          ),
        ).toHaveLength(2),
      );
      for (const open of textControls(physical).filter(
        (message) => message.type === "mux_open",
      )) {
        physical.receiveControl({
          type: "mux_opened",
          circuitId: open.circuitId,
        });
      }
      return {
        physical,
        sockets: await Promise.all([alphaPromise, betaPromise]),
      };
    };

    const first = await openPair(1);
    first.physical.close(1012, "Relay restarting");
    expect(first.sockets[0].readyState).toBe(WebSocket.CLOSED);
    expect(first.sockets[1].readyState).toBe(WebSocket.CLOSED);

    const second = await openPair(2);
    expect(FakePhysicalWebSocket.instances).toHaveLength(2);
    expect(second.sockets[0].readyState).toBe(WebSocket.OPEN);
    expect(second.sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(openLegacySocket).not.toHaveBeenCalled();
    pool.dispose();
  });

  it("does not fall back or expose circuits when disposed during mux setup", async () => {
    FakePhysicalWebSocket.instances = [];
    const hosts = [savedHost("alpha"), savedHost("beta")];
    const openLegacySocket = vi.fn();
    const pool = new RelayMuxSocketPool(hosts, {
      createWebSocket: (url) =>
        new FakePhysicalWebSocket(url) as unknown as WebSocket,
      fetch: muxFetch(),
      openLegacySocket,
    });
    const alpha = pool.createSocketFactory(hosts[0]!)({
      relayUrl: hosts[0]!.relayUrl!,
      relayUsername: "alpha",
    });
    const beta = pool.createSocketFactory(hosts[1]!)({
      relayUrl: hosts[1]!.relayUrl!,
      relayUsername: "beta",
    });
    await vi.waitFor(() =>
      expect(FakePhysicalWebSocket.instances).toHaveLength(1),
    );

    pool.dispose();
    const physical = FakePhysicalWebSocket.instances[0]!;
    physical.open();
    physical.receiveControl({
      type: "mux_ready",
      protocolVersion: 1,
      maxCircuits: 5,
      maxFrameBytes: 1024,
    });

    await expect(alpha).rejects.toMatchObject({ name: "AbortError" });
    await expect(beta).rejects.toMatchObject({ name: "AbortError" });
    expect(physical.readyState).toBe(WebSocket.CLOSED);
    expect(openLegacySocket).not.toHaveBeenCalled();
  });
});
