import { describe, expect, it } from "vitest";
import {
  BROWSER_DEBUG_LEASE_TTL_MS,
  BrowserDebugError,
  BrowserDebugService,
  createBrowserDebugCallerToken,
} from "../../src/services/BrowserDebugService.js";

function grantSecret(grantUrl: string): string {
  return new URL(grantUrl).searchParams.get("grant") ?? "";
}

describe("BrowserDebugService", () => {
  it("derives a stable, domain-separated factor from one provider-host boot", () => {
    const first = createBrowserDebugCallerToken("provider-host-token");

    expect(first).toBe(createBrowserDebugCallerToken("provider-host-token"));
    expect(first).not.toBe("provider-host-token");
    expect(first).not.toBe(
      createBrowserDebugCallerToken("replacement-provider-host-token"),
    );
  });

  it("carries a self-signed trust anchor only in the agent URL fragment", () => {
    const service = new BrowserDebugService();
    const certificate =
      "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----";

    const environment = service.getAgentEnvironment(
      "https://127.0.0.1:3400/",
      certificate,
    );
    const agentUrl = new URL(environment.YEP_BROWSER_DEBUG_AGENT_URL ?? "");
    const encodedCa = new URLSearchParams(agentUrl.hash.slice(1)).get("ya-ca");

    expect(agentUrl.pathname).toBe("/browser-debug/v1");
    expect(Buffer.from(encodedCa ?? "", "base64url").toString("utf8")).toBe(
      certificate,
    );
  });

  it("creates independent per-tab grants with a hard 30-minute expiry", () => {
    let now = 10_000;
    const service = new BrowserDebugService(() => now);
    const first = service.createLease("session-1", "tab-1");
    const second = service.createLease("session-1", "tab-2");

    expect(first.leaseId).not.toBe(second.leaseId);
    expect(first.controllerToken).not.toBe(second.controllerToken);
    expect(first.grantUrl).not.toBe(second.grantUrl);
    expect(Date.parse(first.expiresAt) - now).toBe(BROWSER_DEBUG_LEASE_TTL_MS);
    expect(
      service.getLeaseInfo(first.leaseId, grantSecret(first.grantUrl)),
    ).toMatchObject({ sessionId: "session-1", tabId: "tab-1" });

    now += BROWSER_DEBUG_LEASE_TTL_MS;
    expect(() =>
      service.getLeaseInfo(first.leaseId, grantSecret(first.grantUrl)),
    ).toThrowError(BrowserDebugError);
  });

  it("requires the boot caller credential independently from a tab grant", () => {
    const service = new BrowserDebugService();

    expect(() => service.authorizeCaller("wrong")).toThrowError(
      "Browser diagnostics caller denied",
    );
    expect(() => service.authorizeCaller(service.callerToken)).not.toThrow();
  });

  it("round-trips one full JavaScript evaluation through the browser poll", async () => {
    const service = new BrowserDebugService();
    const lease = service.createLease("session-1", "tab-1");
    const grant = grantSecret(lease.grantUrl);
    const evaluation = service.evaluate(lease.leaseId, grant, "document.title");

    const command = await service.poll(lease.leaseId, lease.controllerToken, 1);
    expect(command).toMatchObject({ kind: "eval", code: "document.title" });
    if (!command) throw new Error("expected evaluation command");
    service.submitResult(
      lease.leaseId,
      lease.controllerToken,
      command.commandId,
      {
        ok: true,
        value: "YA",
      },
    );

    await expect(evaluation).resolves.toEqual({ ok: true, value: "YA" });
  });

  it("keeps a bounded event tail and rejects crossed credentials", () => {
    const service = new BrowserDebugService();
    const first = service.createLease("session-1", "tab-1");
    const second = service.createLease("session-1", "tab-2");
    const firstGrant = grantSecret(first.grantUrl);

    expect(() =>
      service.appendEvents(first.leaseId, second.controllerToken, [
        { timestamp: 1, kind: "console.log" },
      ]),
    ).toThrowError("Browser diagnostic lease not found");

    service.appendEvents(first.leaseId, first.controllerToken, [
      { timestamp: 1, kind: "console.log", data: ["hello"] },
      { timestamp: 2, kind: "metrics.sample" },
    ]);
    expect(service.readEvents(first.leaseId, firstGrant, 1)).toEqual([
      expect.objectContaining({ sequence: 2, kind: "metrics.sample" }),
    ]);
  });
});
