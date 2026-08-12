import { describe, expect, it, vi } from "vitest";
import {
  createProviderHostRoutes,
  type ProviderHostRoutesDeps,
} from "../../src/routes/provider-host.js";

function deps(
  overrides: Partial<ProviderHostRoutesDeps> = {},
): ProviderHostRoutesDeps {
  return {
    available: () => true,
    status: async () => ({ protocolVersion: 3, runtimeCount: 1 }),
    inventory: async () => [
      {
        runtimeId: "runtime-1",
        harness: "claude",
        providerSessionId: "provider-1",
      },
    ],
    streamTurn: async function* (request) {
      yield { type: "accepted", submissionId: request.submissionId };
      yield {
        type: "providerEvent",
        submissionId: request.submissionId,
        sequence: 1,
        message: { type: "result" },
      };
      yield {
        type: "terminal",
        submissionId: request.submissionId,
        outcome: "completed",
      };
    },
    turnStatus: async (submissionId) => ({
      submissionId,
      state: "terminal",
      outcome: "completed",
    }),
    interruptTurn: async () => ({ requested: true }),
    ...overrides,
  };
}

const validTurn = {
  submissionId: "submission-1",
  target: {
    harness: "claude",
    providerSessionId: "provider-1",
    yaSessionId: "ya-1",
  },
  message: { text: "continue the incumbent session", mode: "default" },
};

describe("provider host routes", () => {
  it("reports unavailable without attempting host control", async () => {
    const status = vi.fn();
    const routes = createProviderHostRoutes(
      deps({ available: () => false, status }),
    );

    const response = await routes.request("/status");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "unavailable",
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("adapts status and runtime inventory without exposing worker sockets", async () => {
    const routes = createProviderHostRoutes(deps());

    const status = await routes.request("/status");
    const inventory = await routes.request("/runtimes");

    await expect(status.json()).resolves.toEqual({
      available: true,
      protocolVersion: 3,
      runtimeCount: 1,
    });
    await expect(inventory.json()).resolves.toEqual({
      runtimes: [
        {
          runtimeId: "runtime-1",
          harness: "claude",
          providerSessionId: "provider-1",
        },
      ],
    });
  });

  it("streams accepted, provider, and terminal records", async () => {
    const requests: unknown[] = [];
    const routes = createProviderHostRoutes(
      deps({
        streamTurn: async function* (request) {
          requests.push(request);
          yield { type: "terminal", outcome: "completed" };
        },
      }),
    );
    const response = await routes.request("/session-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTurn),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/x-ndjson",
    );
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual(["terminal"]);
    expect(requests).toMatchObject([
      {
        sessionOptions: {
          automaticTitle: false,
          automaticRecaps: false,
          agentProgressSummaries: false,
          promptSuggestions: false,
        },
      },
    ]);
  });

  it("rejects unknown or non-boolean provider session options", async () => {
    const streamTurn = vi.fn();
    const routes = createProviderHostRoutes(deps({ streamTurn }));
    const unknown = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify({
        ...validTurn,
        sessionOptions: { hiddenGeneration: false },
      }),
    });
    const nonBoolean = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify({
        ...validTurn,
        sessionOptions: { automaticTitle: "off" },
      }),
    });

    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      error: "Unknown provider session option hiddenGeneration",
    });
    expect(nonBoolean.status).toBe(400);
    await expect(nonBoolean.json()).resolves.toMatchObject({
      error: "Provider session option automaticTitle must be boolean",
    });
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("marks adapter failure after acceptance as uncertain", async () => {
    const routes = createProviderHostRoutes(
      deps({
        streamTurn: async function* () {
          yield { type: "accepted", submissionId: "submission-1" };
          throw new Error("control socket closed");
        },
      }),
    );
    const response = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify(validTurn),
    });
    const records = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.at(-1)).toMatchObject({
      type: "error",
      outcome: "uncertain-after-acceptance",
      accepted: true,
    });
  });

  it("rejects launch authority and malformed messages at the HTTP boundary", async () => {
    const streamTurn = vi.fn();
    const routes = createProviderHostRoutes(deps({ streamTurn }));
    const response = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify({
        ...validTurn,
        launch: { providerName: "claude" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "The HTTP adapter cannot launch provider runtimes",
    });
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("bounds HTTP request size and turn duration before host submission", async () => {
    const streamTurn = vi.fn();
    const routes = createProviderHostRoutes(deps({ streamTurn }));
    const oversized = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify({
        ...validTurn,
        message: { text: "x".repeat(1024 * 1024) },
      }),
    });
    const excessiveTimeout = await routes.request("/session-turn", {
      method: "POST",
      body: JSON.stringify({ ...validTurn, timeoutMs: 2 * 60 * 60_000 + 1 }),
    });

    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({
      error: "Session-turn request exceeds 1 MiB",
    });
    expect(excessiveTimeout.status).toBe(400);
    await expect(excessiveTimeout.json()).resolves.toMatchObject({
      error: "timeoutMs must be between 1000 and 7200000",
    });
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it("exposes receipt lookup and bounded interruption", async () => {
    const routes = createProviderHostRoutes(deps());

    const status = await routes.request("/session-turn/submission-1");
    const interruption = await routes.request(
      "/session-turn/submission-1/interrupt",
      { method: "POST" },
    );

    await expect(status.json()).resolves.toMatchObject({
      state: "terminal",
      outcome: "completed",
    });
    await expect(interruption.json()).resolves.toEqual({ requested: true });
  });
});
