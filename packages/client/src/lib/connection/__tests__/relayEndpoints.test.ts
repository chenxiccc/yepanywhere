import { describe, expect, it } from "vitest";
import { relayEndpoints } from "../relayEndpoints";

describe("relayEndpoints", () => {
  it("preserves a configured relay subpath for HTTP and mux endpoints", () => {
    expect(relayEndpoints("wss://relay.example/team/ws")).toEqual({
      healthUrl: "https://relay.example/team/health",
      httpBaseUrl: "https://relay.example/team/",
      key: "wss://relay.example/team",
      muxUrl: "wss://relay.example/team/mux",
      relayUrl: "wss://relay.example/team/ws",
      statsUrl: "https://relay.example/team/stats",
    });
  });

  it("normalizes an HTTP relay input before deriving endpoints", () => {
    expect(relayEndpoints("http://relay.example/ws")?.statsUrl).toBe(
      "http://relay.example/stats",
    );
  });

  it("rejects an invalid configured relay URL", () => {
    expect(relayEndpoints("ftp://relay.example/ws")).toBeNull();
  });
});
