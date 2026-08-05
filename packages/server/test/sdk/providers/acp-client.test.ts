import { describe, expect, it, vi } from "vitest";
import type { Client } from "@agentclientprotocol/sdk";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";

function handlersFor(client: ACPClient): Client {
  return (
    client as unknown as {
      createClientHandlers(): Client;
    }
  ).createClientHandlers();
}

describe("ACPClient extension methods", () => {
  it("forwards extension requests to the registered callback", async () => {
    const client = new ACPClient();
    const callback = vi.fn().mockResolvedValue({ outcome: "accepted" });
    client.setExtensionMethodCallback(callback);

    const handlers = handlersFor(client);
    await expect(
      handlers.extMethod?.("x.ai/ask_user_question", {
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(callback).toHaveBeenCalledWith("x.ai/ask_user_question", {
      sessionId: "session-1",
    });
  });

  it("does not claim extension support without a callback", () => {
    const client = new ACPClient();
    expect(handlersFor(client).extMethod).toBeUndefined();
  });
});

describe("ACPClient.loadSession", () => {
  function withFakeConnection(client: ACPClient) {
    const loadSession = vi.fn().mockResolvedValue({});
    (client as unknown as { connection: unknown }).connection = { loadSession };
    return loadSession;
  }

  it("sends the id, cwd and an empty MCP list", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo");

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/repo",
      mcpServers: [],
    });
  });

  it("forwards caller metadata as the request's _meta", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo", { noReplay: true });

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/repo",
      mcpServers: [],
      _meta: { noReplay: true },
    });
  });

  it("omits _meta entirely when the caller passes none", async () => {
    const client = new ACPClient();
    const loadSession = withFakeConnection(client);

    await client.loadSession("session-1", "/repo");

    expect(loadSession.mock.calls[0]?.[0]).not.toHaveProperty("_meta");
  });

  it("refuses to load before connect", async () => {
    await expect(new ACPClient().loadSession("s", "/repo")).rejects.toThrow(
      /not connected/i,
    );
  });
});
