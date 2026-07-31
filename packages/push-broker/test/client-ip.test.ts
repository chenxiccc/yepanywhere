import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  getClientIp,
  parseTrustedProxies,
} from "../src/client-ip.js";

function makeRequest(
  remoteAddress: string,
  forwardedFor?: string | string[],
): IncomingMessage {
  return {
    socket: { remoteAddress } as IncomingMessage["socket"],
    headers:
      forwardedFor === undefined
        ? {}
        : { "x-forwarded-for": forwardedFor },
  } as IncomingMessage;
}

describe("push broker client IP resolution", () => {
  it("ignores forwarded addresses from untrusted peers", () => {
    const request = makeRequest("203.0.113.7", "198.51.100.9");
    const trusted = parseTrustedProxies("127.0.0.1").proxies;

    expect(getClientIp(request, trusted)).toBe("203.0.113.7");
  });

  it("walks a chain received from an explicitly trusted proxy", () => {
    const request = makeRequest(
      "::ffff:127.0.0.1",
      "203.0.113.7, 10.0.0.8",
    );
    const trusted = parseTrustedProxies(
      "127.0.0.1,10.0.0.0/8",
    ).proxies;

    expect(getClientIp(request, trusted)).toBe("203.0.113.7");
  });

  it("supports IPv6 CIDR proxies", () => {
    const request = makeRequest("fd12:3456::1", "2001:db8::5");
    const trusted = parseTrustedProxies("fc00::/7").proxies;

    expect(getClientIp(request, trusted)).toBe("2001:db8::5");
  });

  it("reports malformed trusted proxy entries", () => {
    const parsed = parseTrustedProxies(
      "127.0.0.1,not-an-ip,10.0.0.0/33",
    );

    expect(parsed.proxies).toHaveLength(1);
    expect(parsed.invalidEntries).toEqual([
      "not-an-ip",
      "10.0.0.0/33",
    ]);
  });
});
