import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeHostClient,
  type NativeHostRawChannel,
} from "../nativeHost";

class FakeChannel implements NativeHostRawChannel {
  onmessage: NativeHostRawChannel["onmessage"] = null;
  requests: Array<Record<string, unknown>> = [];
  responder?: (request: Record<string, unknown>) => unknown;

  postMessage(message: string): void {
    const request = JSON.parse(message) as Record<string, unknown>;
    this.requests.push(request);
    const response = this.responder?.(request);
    if (response !== undefined) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeHostClient", () => {
  it("quietly reports an absent native host", async () => {
    const client = new NativeHostClient({ getChannel: () => undefined });

    await expect(client.describe()).resolves.toBeNull();
    client.dispose();
  });

  it("performs and caches the host.describe handshake", async () => {
    const channel = new FakeChannel();
    channel.responder = (request) => ({
      protocol: 1,
      id: request.id,
      ok: true,
      result: {
        protocol: 1,
        platform: "android",
        appVersion: "0.1.0",
        buildVersion: 1000,
        features: [],
      },
    });
    const client = new NativeHostClient({ getChannel: () => channel });

    await expect(client.describe()).resolves.toEqual({
      protocol: 1,
      platform: "android",
      appVersion: "0.1.0",
      buildVersion: 1000,
      features: [],
    });
    await client.describe();
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0]).toMatchObject({
      protocol: 1,
      method: "host.describe",
    });
    client.dispose();
  });

  it("treats malformed descriptors and native errors as unavailable", async () => {
    const channel = new FakeChannel();
    channel.responder = (request) => ({
      protocol: 1,
      id: request.id,
      ok: true,
      result: { protocol: 1, platform: "android", features: "all" },
    });
    const client = new NativeHostClient({ getChannel: () => channel });
    await expect(client.describe()).resolves.toBeNull();
    client.dispose();

    const deniedChannel = new FakeChannel();
    deniedChannel.responder = (request) => ({
      protocol: 1,
      id: request.id,
      ok: false,
      error: { code: "unknown_method", message: "Method is not supported" },
    });
    const deniedClient = new NativeHostClient({
      getChannel: () => deniedChannel,
    });
    await expect(deniedClient.describe()).resolves.toBeNull();
    deniedClient.dispose();
  });

  it("times out malformed replies without logging", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    channel.responder = () => "not a response envelope";
    const client = new NativeHostClient({
      getChannel: () => channel,
      timeoutMs: 25,
    });

    const result = client.describe();
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBeNull();
    client.dispose();
  });

  it("cancels pending calls when the document is hidden", async () => {
    const channel = new FakeChannel();
    const client = new NativeHostClient({
      getChannel: () => channel,
      timeoutMs: 10_000,
    });

    const result = client.describe();
    window.dispatchEvent(new Event("pagehide"));
    await expect(result).resolves.toBeNull();
    client.dispose();
  });
});
