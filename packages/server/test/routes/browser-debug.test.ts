import { describe, expect, it } from "vitest";
import {
  createBrowserDebugAgentRoutes,
  createBrowserDebugClientRoutes,
} from "../../src/routes/browser-debug.js";
import { BrowserDebugService } from "../../src/services/BrowserDebugService.js";

function jsonRequest(body: unknown, headers: HeadersInit = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function streamedJsonRequest(
  url: string,
  body: unknown,
  headers: HeadersInit = {},
): Request {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 4_096, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("browser debug routes", () => {
  it("requires both YA caller authorization and the per-tab grant", async () => {
    const service = new BrowserDebugService();
    const client = createBrowserDebugClientRoutes(service);
    const agent = createBrowserDebugAgentRoutes(service);
    const created = await client.request(
      "/leases",
      jsonRequest({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const { lease } = (await created.json()) as {
      lease: { leaseId: string; grantUrl: string };
    };
    const grant = new URL(lease.grantUrl).searchParams.get("grant") ?? "";

    expect((await agent.request(`/leases/${lease.leaseId}`)).status).toBe(401);
    expect(
      (
        await agent.request(`/leases/${lease.leaseId}`, {
          headers: { Authorization: `Bearer ${service.callerToken}` },
        })
      ).status,
    ).toBe(404);
    const authorized = await agent.request(`/leases/${lease.leaseId}`, {
      headers: {
        Authorization: `Bearer ${service.callerToken}`,
        "X-YA-Browser-Debug-Grant": grant,
      },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      lease: { sessionId: "session-1", tabId: "tab-1" },
    });
  });

  it("brokers evaluation and event tailing without exposing the grant to the tab", async () => {
    const service = new BrowserDebugService();
    const client = createBrowserDebugClientRoutes(service);
    const agent = createBrowserDebugAgentRoutes(service);
    const created = await client.request(
      "/leases",
      jsonRequest({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const { lease } = (await created.json()) as {
      lease: {
        leaseId: string;
        controllerToken: string;
        grantUrl: string;
      };
    };
    const controllerHeaders = {
      "X-YA-Browser-Debug-Controller": lease.controllerToken,
    };
    const agentHeaders = {
      Authorization: `Bearer ${service.callerToken}`,
      "X-YA-Browser-Debug-Grant":
        new URL(lease.grantUrl).searchParams.get("grant") ?? "",
    };

    const evaluation = agent.request(
      `/leases/${lease.leaseId}/eval`,
      jsonRequest({ code: "location.href" }, agentHeaders),
    );
    const polled = await client.request(
      `/leases/${lease.leaseId}/poll`,
      jsonRequest({}, controllerHeaders),
    );
    const { command } = (await polled.json()) as {
      command: { commandId: string; code: string };
    };
    expect(command.code).toBe("location.href");
    await client.request(
      `/leases/${lease.leaseId}/results`,
      jsonRequest(
        {
          commandId: command.commandId,
          result: { ok: true, value: "/session" },
        },
        controllerHeaders,
      ),
    );
    const evaluated = await evaluation;
    expect(evaluated.status).toBe(200);
    await expect(evaluated.json()).resolves.toEqual({
      result: { ok: true, value: "/session" },
    });

    await client.request(
      `/leases/${lease.leaseId}/events`,
      jsonRequest(
        { events: [{ timestamp: 1, kind: "performance.frame-gap" }] },
        controllerHeaders,
      ),
    );
    const events = await agent.request(
      `/leases/${lease.leaseId}/events?after=0`,
      { headers: agentHeaders },
    );
    await expect(events.json()).resolves.toMatchObject({
      events: [{ sequence: 1, kind: "performance.frame-gap" }],
    });

    expect(JSON.stringify(lease)).not.toContain(service.callerToken);
  });

  it("rejects oversized tab payloads before parsing them", async () => {
    const service = new BrowserDebugService();
    const client = createBrowserDebugClientRoutes(service);
    const created = await client.request(
      "/leases",
      jsonRequest({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const { lease } = (await created.json()) as {
      lease: { leaseId: string; controllerToken: string };
    };

    const response = await client.fetch(
      streamedJsonRequest(
        `http://localhost/leases/${lease.leaseId}/events`,
        {
          events: [
            {
              timestamp: 1,
              kind: "console.log",
              data: "x".repeat(300 * 1024),
            },
          ],
        },
        { "X-YA-Browser-Debug-Controller": lease.controllerToken },
      ),
    );

    expect(response.status).toBe(413);
  });

  it("rejects malformed event cursors instead of replaying from zero", async () => {
    const service = new BrowserDebugService();
    const client = createBrowserDebugClientRoutes(service);
    const agent = createBrowserDebugAgentRoutes(service);
    const created = await client.request(
      "/leases",
      jsonRequest({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const { lease } = (await created.json()) as {
      lease: { leaseId: string; grantUrl: string };
    };

    const response = await agent.request(
      `/leases/${lease.leaseId}/events?after=12garbage`,
      {
        headers: {
          Authorization: `Bearer ${service.callerToken}`,
          "X-YA-Browser-Debug-Grant":
            new URL(lease.grantUrl).searchParams.get("grant") ?? "",
        },
      },
    );

    expect(response.status).toBe(400);
  });

  it("confirms revocation with a JSON response", async () => {
    const service = new BrowserDebugService();
    const client = createBrowserDebugClientRoutes(service);
    const created = await client.request(
      "/leases",
      jsonRequest({ sessionId: "session-1", tabId: "tab-1" }),
    );
    const { lease } = (await created.json()) as {
      lease: { leaseId: string; controllerToken: string };
    };

    const revoked = await client.request(`/leases/${lease.leaseId}`, {
      method: "DELETE",
      headers: {
        "X-YA-Browser-Debug-Controller": lease.controllerToken,
      },
    });

    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: true });
  });
});
