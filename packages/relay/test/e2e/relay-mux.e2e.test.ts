import { randomUUID } from "node:crypto";
import {
  RELAY_CLIENT_MUX_V1_CAPABILITY,
  type RelayMuxClosed,
  type RelayMuxError,
  type RelayMuxOpened,
  type RelayMuxReady,
  type RelayServerRegister,
  decodeRelayMuxDataFrame,
  encodeRelayMuxDataFrame,
  isRelayMuxClosed,
  isRelayMuxError,
  isRelayMuxOpened,
  isRelayMuxReady,
  isRelayServerRegistered,
} from "@yep-anywhere/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayServer, createRelayServer } from "../../src/server.js";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket open timeout")),
      5000,
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForControl<T>(
  ws: WebSocket,
  guard: (message: unknown) => message is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Mux control timeout"));
    }, 5000);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const message: unknown = JSON.parse(data.toString());
        if (!guard(message)) return;
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(message);
      } catch {
        // Ignore non-JSON text frames.
      }
    };
    ws.on("message", onMessage);
  });
}

function waitForMuxData(
  ws: WebSocket,
  circuitId: number,
): Promise<{ isBinary: boolean; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Mux data timeout"));
    }, 5000);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayMuxDataFrame(Buffer.from(data as Buffer));
      if (frame.circuitId !== circuitId) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve({
        isBinary: frame.isBinary,
        payload: Buffer.from(frame.payload),
      });
    };
    ws.on("message", onMessage);
  });
}

describe("Relay client mux E2E", () => {
  let relay: RelayServer;
  let wsBase: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    relay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      muxIdleTimeoutMs: 5000,
    });
    wsBase = `ws://localhost:${relay.port}`;
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    }
  });

  afterAll(async () => {
    await relay.close();
  });

  async function connect(path: "/ws" | "/mux"): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBase}${path}`);
    sockets.push(socket);
    await waitForOpen(socket);
    return socket;
  }

  async function register(username: string): Promise<WebSocket> {
    const socket = await connect("/ws");
    const registered = waitForControl(socket, isRelayServerRegistered);
    const message: RelayServerRegister = {
      type: "server_register",
      username,
      installId: randomUUID(),
    };
    socket.send(JSON.stringify(message));
    await registered;
    return socket;
  }

  async function openMux(): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBase}/mux`);
    sockets.push(socket);
    const ready = waitForControl(socket, isRelayMuxReady);
    await waitForOpen(socket);
    expect(await ready).toMatchObject<RelayMuxReady>({
      type: "mux_ready",
      protocolVersion: 1,
      maxCircuits: 5,
      maxFrameBytes: 2 * 1024 * 1024,
    });
    return socket;
  }

  async function openCircuit(
    mux: WebSocket,
    circuitId: number,
    username: string,
  ): Promise<RelayMuxOpened> {
    const opened = waitForControl(mux, isRelayMuxOpened);
    mux.send(
      JSON.stringify({
        type: "mux_open",
        circuitId,
        username,
        channel: "app",
      }),
    );
    return opened;
  }

  it("advertises mux without changing the legacy health fields", async () => {
    const response = await fetch(`http://localhost:${relay.port}/health`);
    expect(await response.json()).toMatchObject({
      status: "ok",
      waiting: 0,
      pairs: 0,
      relayCapabilities: [RELAY_CLIENT_MUX_V1_CAPABILITY],
    });
  });

  it("routes independent text and binary circuits over one socket", async () => {
    const usernames = [
      `mux-a-${randomUUID().slice(0, 8)}`,
      `mux-b-${randomUUID().slice(0, 8)}`,
      `mux-c-${randomUUID().slice(0, 8)}`,
    ];
    const servers = await Promise.all(usernames.map(register));
    const mux = await openMux();

    for (let index = 0; index < usernames.length; index += 1) {
      const username = usernames[index];
      if (!username) throw new Error("Missing mux test username");
      await expect(openCircuit(mux, index + 1, username)).resolves.toEqual({
        type: "mux_opened",
        circuitId: index + 1,
      });
    }

    const serverText = new Promise<{
      data: Buffer;
      isBinary: boolean;
    }>((resolve) => {
      servers[0]?.once("message", (data, isBinary) =>
        resolve({ data: Buffer.from(data as Buffer), isBinary }),
      );
    });
    mux.send(
      encodeRelayMuxDataFrame(
        1,
        new TextEncoder().encode("client text"),
        false,
      ),
    );
    await expect(serverText).resolves.toEqual({
      data: Buffer.from("client text"),
      isBinary: false,
    });

    const serverBinary = new Promise<{
      data: Buffer;
      isBinary: boolean;
    }>((resolve) => {
      servers[1]?.once("message", (data, isBinary) =>
        resolve({ data: Buffer.from(data as Buffer), isBinary }),
      );
    });
    mux.send(
      encodeRelayMuxDataFrame(2, new Uint8Array([0, 1, 2, 255]), true),
    );
    await expect(serverBinary).resolves.toEqual({
      data: Buffer.from([0, 1, 2, 255]),
      isBinary: true,
    });

    const muxText = waitForMuxData(mux, 3);
    servers[2]?.send("server text");
    await expect(muxText).resolves.toEqual({
      isBinary: false,
      payload: Buffer.from("server text"),
    });

    const muxBinary = waitForMuxData(mux, 1);
    servers[0]?.send(Buffer.from([9, 8, 7]));
    await expect(muxBinary).resolves.toEqual({
      isBinary: true,
      payload: Buffer.from([9, 8, 7]),
    });

    const statusResponse = await fetch(
      `http://localhost:${relay.port}/status`,
    );
    expect(await statusResponse.json()).toMatchObject({
      mux: {
        physicalSockets: 1,
        liveCircuits: 3,
        openedTotal: 3,
      },
    });
  });

  it("isolates open errors and circuit closure from healthy peers", async () => {
    const alphaName = `mux-alpha-${randomUUID().slice(0, 8)}`;
    const betaName = `mux-beta-${randomUUID().slice(0, 8)}`;
    const alpha = await register(alphaName);
    const beta = await register(betaName);
    const mux = await openMux();
    await openCircuit(mux, 1, alphaName);
    await openCircuit(mux, 2, betaName);

    const errorPromise = waitForControl<RelayMuxError>(mux, isRelayMuxError);
    mux.send(
      JSON.stringify({
        type: "mux_open",
        circuitId: 3,
        username: `missing-${randomUUID().slice(0, 8)}`,
        channel: "app",
      }),
    );
    await expect(errorPromise).resolves.toMatchObject({
      type: "mux_error",
      circuitId: 3,
      reason: "unknown_username",
    });

    const closedPromise = waitForControl<RelayMuxClosed>(mux, isRelayMuxClosed);
    const alphaClosed = new Promise<void>((resolve) =>
      alpha.once("close", () => resolve()),
    );
    mux.send(JSON.stringify({ type: "mux_close", circuitId: 1 }));
    await expect(closedPromise).resolves.toEqual({
      type: "mux_closed",
      circuitId: 1,
      reason: "client_closed",
    });
    await alphaClosed;

    const betaMessage = new Promise<string>((resolve) =>
      beta.once("message", (data) => resolve(data.toString())),
    );
    mux.send(
      encodeRelayMuxDataFrame(
        2,
        new TextEncoder().encode("still healthy"),
        false,
      ),
    );
    await expect(betaMessage).resolves.toBe("still healthy");
    expect(mux.readyState).toBe(WebSocket.OPEN);
  });

  it("closes every claimed server when the physical mux closes", async () => {
    const alphaName = `mux-drop-a-${randomUUID().slice(0, 8)}`;
    const betaName = `mux-drop-b-${randomUUID().slice(0, 8)}`;
    const alpha = await register(alphaName);
    const beta = await register(betaName);
    const mux = await openMux();
    await openCircuit(mux, 1, alphaName);
    await openCircuit(mux, 2, betaName);

    const closed = [alpha, beta].map(
      (socket) =>
        new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    mux.close();
    await Promise.all(closed);
    await expect
      .poll(() => relay.connectionManager.getPairCount())
      .toBe(0);
  });

  it("enforces the per-socket circuit limit without closing healthy circuits", async () => {
    const usernames = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const username = `mux-limit-${index}-${randomUUID().slice(0, 8)}`;
        await register(username);
        return username;
      }),
    );
    const mux = await openMux();
    for (let index = 0; index < 5; index += 1) {
      await openCircuit(mux, index + 1, usernames[index]!);
    }

    const error = waitForControl<RelayMuxError>(mux, isRelayMuxError);
    mux.send(
      JSON.stringify({
        type: "mux_open",
        circuitId: 6,
        username: usernames[5],
        channel: "app",
      }),
    );
    await expect(error).resolves.toEqual({
      type: "mux_error",
      circuitId: 6,
      reason: "circuit_limit",
    });

    const healthyMessage = new Promise<string>((resolve) =>
      sockets[0]?.once("message", (data) => resolve(data.toString())),
    );
    mux.send(
      encodeRelayMuxDataFrame(
        1,
        new TextEncoder().encode("still open"),
        false,
      ),
    );
    await expect(healthyMessage).resolves.toBe("still open");
  });

  it("enforces the live-circuit limit across mux sockets from one IP", async () => {
    const boundedRelay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      muxMaxCircuitsPerIp: 2,
    });
    const localSockets: WebSocket[] = [];
    const localBase = `ws://localhost:${boundedRelay.port}`;
    const localConnect = async (path: "/ws" | "/mux") => {
      const socket = new WebSocket(`${localBase}${path}`);
      localSockets.push(socket);
      await waitForOpen(socket);
      return socket;
    };
    const localRegister = async (username: string) => {
      const server = await localConnect("/ws");
      const registered = waitForControl(server, isRelayServerRegistered);
      server.send(
        JSON.stringify({
          type: "server_register",
          username,
          installId: randomUUID(),
        }),
      );
      await registered;
      return server;
    };
    const localMux = async () => {
      const mux = new WebSocket(`${localBase}/mux`);
      localSockets.push(mux);
      const ready = waitForControl(mux, isRelayMuxReady);
      await waitForOpen(mux);
      await ready;
      return mux;
    };

    try {
      const usernames = Array.from(
        { length: 3 },
        (_, index) => `mux-ip-limit-${index}-${randomUUID().slice(0, 8)}`,
      );
      await Promise.all(usernames.map(localRegister));
      const firstMux = await localMux();
      const secondMux = await localMux();
      await openCircuit(firstMux, 1, usernames[0]!);
      await openCircuit(secondMux, 1, usernames[1]!);

      const limited = waitForControl<RelayMuxError>(
        secondMux,
        isRelayMuxError,
      );
      secondMux.send(
        JSON.stringify({
          type: "mux_open",
          circuitId: 2,
          username: usernames[2],
          channel: "app",
        }),
      );
      await expect(limited).resolves.toEqual({
        type: "mux_error",
        circuitId: 2,
        reason: "circuit_limit",
      });
      expect(firstMux.readyState).toBe(WebSocket.OPEN);
      expect(secondMux.readyState).toBe(WebSocket.OPEN);
    } finally {
      for (const socket of localSockets) socket.close();
      await boundedRelay.close();
    }
  });

  it("rate-limits repeated opens for one IP and username", async () => {
    const mux = await openMux();
    const username = `mux-rate-${randomUUID().slice(0, 8)}`;

    for (let circuitId = 1; circuitId <= 6; circuitId += 1) {
      const error = waitForControl<RelayMuxError>(mux, isRelayMuxError);
      mux.send(
        JSON.stringify({
          type: "mux_open",
          circuitId,
          username,
          channel: "app",
        }),
      );
      await expect(error).resolves.toMatchObject({
        circuitId,
        reason: "unknown_username",
      });
    }

    const limited = waitForControl<RelayMuxError>(mux, isRelayMuxError);
    mux.send(
      JSON.stringify({
        type: "mux_open",
        circuitId: 7,
        username,
        channel: "app",
      }),
    );
    await expect(limited).resolves.toEqual({
      type: "mux_error",
      circuitId: 7,
      reason: "rate_limited",
    });
  });

  it("drains relay-to-client frames round-robin by circuit", async () => {
    const alphaName = `mux-fair-a-${randomUUID().slice(0, 8)}`;
    const betaName = `mux-fair-b-${randomUUID().slice(0, 8)}`;
    const alpha = await register(alphaName);
    const beta = await register(betaName);
    const mux = await openMux();
    await openCircuit(mux, 1, alphaName);
    await openCircuit(mux, 2, betaName);

    const received = new Promise<string[]>((resolve) => {
      const payloads: string[] = [];
      mux.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const frame = decodeRelayMuxDataFrame(Buffer.from(data as Buffer));
        payloads.push(`${frame.circuitId}:${Buffer.from(frame.payload)}`);
        if (payloads.length === 3) resolve(payloads);
      });
    });
    alpha.send("a1");
    alpha.send("a2");
    beta.send("b1");

    await expect(received).resolves.toEqual(["1:a1", "2:b1", "1:a2"]);
  });

  it("closes only the circuit that exceeds the inner frame bound", async () => {
    const boundedRelay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      muxMaxFrameBytes: 8,
    });
    const localSockets: WebSocket[] = [];
    const localBase = `ws://localhost:${boundedRelay.port}`;

    try {
      const username = `mux-frame-${randomUUID().slice(0, 8)}`;
      const server = new WebSocket(`${localBase}/ws`);
      localSockets.push(server);
      await waitForOpen(server);
      const registered = waitForControl(server, isRelayServerRegistered);
      server.send(
        JSON.stringify({
          type: "server_register",
          username,
          installId: randomUUID(),
        }),
      );
      await registered;

      const mux = new WebSocket(`${localBase}/mux`);
      localSockets.push(mux);
      const ready = waitForControl(mux, isRelayMuxReady);
      await waitForOpen(mux);
      await ready;
      await openCircuit(mux, 1, username);

      const closed = waitForControl<RelayMuxClosed>(mux, isRelayMuxClosed);
      mux.send(encodeRelayMuxDataFrame(1, new Uint8Array(9), true));
      await expect(closed).resolves.toEqual({
        type: "mux_closed",
        circuitId: 1,
        reason: "relay_closed",
      });
      expect(mux.readyState).toBe(WebSocket.OPEN);
    } finally {
      for (const socket of localSockets) socket.close();
      await boundedRelay.close();
    }
  });

  it("closes a circuit whose relay-to-client queue exceeds its bound", async () => {
    const boundedRelay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      muxBufferedAmountHighWaterBytes: -1,
      muxMaxQueuedBytesPerCircuit: 25,
      muxMaxQueuedBytesPerSocket: 50,
    });
    const localSockets: WebSocket[] = [];
    const localBase = `ws://localhost:${boundedRelay.port}`;
    const localConnect = async (path: "/ws" | "/mux") => {
      const socket = new WebSocket(`${localBase}${path}`);
      localSockets.push(socket);
      await waitForOpen(socket);
      return socket;
    };

    try {
      const username = `mux-queue-${randomUUID().slice(0, 8)}`;
      const server = await localConnect("/ws");
      const registered = waitForControl(server, isRelayServerRegistered);
      server.send(
        JSON.stringify({
          type: "server_register",
          username,
          installId: randomUUID(),
        }),
      );
      await registered;

      const mux = new WebSocket(`${localBase}/mux`);
      localSockets.push(mux);
      const ready = waitForControl(mux, isRelayMuxReady);
      await waitForOpen(mux);
      await ready;
      const opened = waitForControl(mux, isRelayMuxOpened);
      mux.send(
        JSON.stringify({
          type: "mux_open",
          circuitId: 1,
          username,
          channel: "app",
        }),
      );
      await opened;

      const closed = waitForControl<RelayMuxClosed>(mux, isRelayMuxClosed);
      server.send("12345678");
      server.send("abcdefgh");
      await expect(closed).resolves.toEqual({
        type: "mux_closed",
        circuitId: 1,
        reason: "relay_closed",
      });
      expect(mux.readyState).toBe(WebSocket.OPEN);
    } finally {
      for (const socket of localSockets) socket.close();
      await boundedRelay.close();
    }
  });

  it("bounds zero-circuit mux lifetime", async () => {
    const idleRelay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      muxIdleTimeoutMs: 20,
    });
    const mux = new WebSocket(`ws://localhost:${idleRelay.port}/mux`);
    try {
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        mux.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
      );
      await waitForOpen(mux);
      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "Idle mux connection",
      });
    } finally {
      mux.close();
      await idleRelay.close();
    }
  });
});
