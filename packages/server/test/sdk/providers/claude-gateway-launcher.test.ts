import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeGatewayLauncher,
  isClaudeGatewayLoopbackUrl,
  resolveClaudeGatewayEndpoint,
} from "../../../src/sdk/providers/claude-gateway-launcher.js";

async function listenOn(host: string): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an ephemeral TCP port");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fakeChild(pid = 1234): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  return child;
}

describe("ClaudeGatewayLauncher", () => {
  it.each([
    "http://localhost:4141",
    "http://localhost.:4141",
    "http://127.0.0.1:4141",
    "http://127.99.2.3:4141",
    "http://[::1]:4141",
  ])("recognizes loopback URL %s", (url) => {
    expect(isClaudeGatewayLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "http://example.com:4141",
    "http://10.0.0.1:4141",
    "http://[::2]:4141",
    "ftp://localhost:4141",
    "not a URL",
  ])("rejects non-loopback URL %s", (url) => {
    expect(isClaudeGatewayLoopbackUrl(url)).toBe(false);
  });

  it("detects a real IPv4 loopback TCP listener", async () => {
    const server = await listenOn("127.0.0.1");
    try {
      await expect(
        resolveClaudeGatewayEndpoint(`http://127.0.0.1:${server.port}`),
      ).resolves.toBe(`http://127.0.0.1:${server.port}`);
    } finally {
      await server.close();
    }
  });

  it("resolves an unreachable loopback endpoint to null", async () => {
    const server = await listenOn("127.0.0.1");
    const port = server.port;
    await server.close();

    await expect(
      resolveClaudeGatewayEndpoint(`http://127.0.0.1:${port}`),
    ).resolves.toBeNull();
  });

  // A one-family bind leaves the other family's socket free on the same port,
  // so `localhost` can front two unrelated gateways. Pin to the one answering.
  it("pins localhost to the address family that answers", async () => {
    let server: Awaited<ReturnType<typeof listenOn>>;
    try {
      server = await listenOn("::1");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return;
      throw error;
    }

    try {
      await expect(
        resolveClaudeGatewayEndpoint(`http://localhost:${server.port}`),
      ).resolves.toBe(`http://[::1]:${server.port}`);
    } finally {
      await server.close();
    }
  });

  it("does not launch when the endpoint already has a listener", async () => {
    const spawnCommand = vi.fn(() => fakeChild());
    const launcher = new ClaudeGatewayLauncher({
      probe: vi.fn(async () => "http://[::1]:4141"),
      spawnCommand,
    });

    await expect(
      launcher.ensureReady({
        url: "http://localhost:4141",
        startCommand: "gateway start",
      }),
    ).resolves.toBe("http://[::1]:4141");
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("resolves a listening endpoint with no start command configured", async () => {
    const spawnCommand = vi.fn(() => fakeChild());
    const launcher = new ClaudeGatewayLauncher({
      probe: vi.fn(async () => "http://127.0.0.1:4141"),
      spawnCommand,
    });

    await expect(
      launcher.ensureReady({ url: "http://localhost:4141" }),
    ).resolves.toBe("http://127.0.0.1:4141");
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("never launches a command for a non-loopback endpoint", async () => {
    const probe = vi.fn(async () => null);
    const spawnCommand = vi.fn(() => fakeChild());
    const launcher = new ClaudeGatewayLauncher({ probe, spawnCommand });

    await expect(
      launcher.ensureReady({
        url: "https://gateway.example.com",
        startCommand: "gateway start",
      }),
    ).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it("coalesces concurrent launch attempts until readiness", async () => {
    let listening: string | null = null;
    const child = fakeChild();
    const probe = vi.fn(async () => listening);
    const spawnCommand = vi.fn(() => {
      listening = "http://127.0.0.1:4141";
      return child;
    });
    const signalChild = vi.fn((target: ChildProcess) => {
      target.emit("close", 0, null);
    });
    const launcher = new ClaudeGatewayLauncher({
      probe,
      spawnCommand,
      signalChild,
    });
    const config = {
      url: "http://127.0.0.1:4141",
      startCommand: "gateway start",
    };

    await expect(
      Promise.all([launcher.ensureReady(config), launcher.ensureReady(config)]),
    ).resolves.toEqual(["http://127.0.0.1:4141", "http://127.0.0.1:4141"]);
    expect(spawnCommand).toHaveBeenCalledTimes(1);

    await launcher.shutdown();
    expect(signalChild).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it("kills a command that never opens the endpoint", async () => {
    let now = 0;
    const child = fakeChild();
    const signalChild = vi.fn((target: ChildProcess) => {
      target.emit("close", null, "SIGTERM");
    });
    const launcher = new ClaudeGatewayLauncher({
      probe: vi.fn(async () => null),
      spawnCommand: vi.fn(() => child),
      signalChild,
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds;
      },
      readinessTimeoutMs: 200,
      readinessPollMs: 100,
    });

    await expect(
      launcher.ensureReady({
        url: "http://[::1]:4141",
        startCommand: "gateway start",
      }),
    ).resolves.toBeNull();
    expect(signalChild).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it("terminates an owned child when configuration changes", async () => {
    let listening: string | null = null;
    const child = fakeChild();
    const signalChild = vi.fn((target: ChildProcess) => {
      target.emit("close", 0, "SIGTERM");
    });
    const launcher = new ClaudeGatewayLauncher({
      probe: vi.fn(async () => listening),
      spawnCommand: vi.fn(() => {
        listening = "http://127.0.0.1:4141";
        return child;
      }),
      signalChild,
    });

    await launcher.ensureReady({
      url: "http://localhost:4141",
      startCommand: "gateway start",
    });
    await launcher.configure({
      url: "http://localhost:4041",
      startCommand: "gateway start --port 4041",
    });

    expect(signalChild).toHaveBeenCalledWith(child, "SIGTERM");
  });
});
