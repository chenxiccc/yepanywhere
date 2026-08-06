import type { HttpBindings } from "@hono/node-server";
import type { RelayResponse, YepMessage } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { RelayHandlerDeps } from "../../src/routes/ws-relay-handlers.js";
import {
  createConnectionState,
  handleMessage,
} from "../../src/routes/ws-relay-handlers.js";

/**
 * Tunneled HTTP requests must not head-of-line block one another: the
 * per-connection message queue serializes decrypt/auth/route, but a slow
 * request (e.g. /api/sessions during an index revalidation) has to leave the
 * queue before its response is ready, exactly as it would over plain HTTP.
 */
describe("WS relay request concurrency", () => {
  it("answers a fast request while an earlier slow request is in flight", async () => {
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/api/slow", async (c) => {
      await slowGate;
      return c.json({ which: "slow" });
    });
    app.get("/api/fast", (c) => c.json({ which: "fast" }));

    const sent: YepMessage[] = [];
    const responses = (): RelayResponse[] =>
      sent.filter((m): m is RelayResponse => m.type === "response");
    let notifyResponse: (() => void) | undefined;
    const send = (message: YepMessage) => {
      sent.push(message);
      notifyResponse?.();
    };

    // Local trusted connection: plaintext application messages route without
    // an SRP transport, as in ws-relay.ts onOpen for local mode.
    const connState = createConnectionState();
    connState.connectionPolicy = "local_unrestricted";
    connState.authState = "authenticated";

    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    const ws = { send: () => {}, close: () => {} };
    const dispatch = (id: string, path: string) =>
      handleMessage(
        ws,
        new Map(),
        new Map(),
        connState,
        send,
        JSON.stringify({ type: "request", id, method: "GET", path }),
        deps,
        {},
      );

    // Mirrors the connection's serialized message queue: each handleMessage
    // is awaited before the next starts.
    await dispatch("req-slow", "/api/slow");
    await dispatch("req-fast", "/api/fast");

    // The fast response must arrive while the slow request is still gated.
    await new Promise<void>((resolve) => {
      if (responses().length > 0) return resolve();
      notifyResponse = resolve;
    });
    expect(responses().map((r) => r.id)).toEqual(["req-fast"]);

    releaseSlow?.();
    await new Promise<void>((resolve) => {
      if (responses().length === 2) return resolve();
      notifyResponse = () => {
        if (responses().length === 2) resolve();
      };
    });
    expect(responses().map((r) => r.id)).toEqual(["req-fast", "req-slow"]);
    expect(responses()[1]).toMatchObject({
      status: 200,
      body: { which: "slow" },
    });
  });

  it("forwards Location so relay clients can follow API redirects", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/api/original", (c) => c.redirect("/api/redirected", 307));

    const sent: YepMessage[] = [];
    const connState = createConnectionState();
    connState.connectionPolicy = "local_unrestricted";
    connState.authState = "authenticated";
    const deps = {
      app,
      baseUrl: "http://localhost",
      supervisor: {},
      eventBus: {},
      uploadManager: {},
    } as unknown as RelayHandlerDeps;

    await handleMessage(
      { send: () => {}, close: () => {} },
      new Map(),
      new Map(),
      connState,
      (message) => sent.push(message),
      JSON.stringify({
        type: "request",
        id: "req-redirect",
        method: "GET",
        path: "/api/original",
      }),
      deps,
      {},
    );

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toMatchObject({
      type: "response",
      status: 307,
      headers: { location: "/api/redirected" },
    });
  });
});
