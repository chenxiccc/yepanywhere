import { normalizeRelayUrl } from "@yep-anywhere/shared";

export interface RelayEndpoints {
  healthUrl: string;
  httpBaseUrl: string;
  key: string;
  muxUrl: string;
  relayUrl: string;
  statsUrl: string;
}

/** Derive relay-owned HTTP and WebSocket endpoints from its configured /ws URL. */
export function relayEndpoints(rawRelayUrl: string): RelayEndpoints | null {
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(rawRelayUrl);
  } catch {
    return null;
  }
  const wsUrl = new URL(relayUrl);
  if (!wsUrl.pathname.endsWith("/ws")) return null;
  const basePath = wsUrl.pathname.slice(0, -3);

  const muxUrl = new URL(wsUrl);
  muxUrl.pathname = `${basePath}/mux`;

  const httpBaseUrl = new URL(wsUrl);
  httpBaseUrl.protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  httpBaseUrl.pathname = `${basePath}/`;

  return {
    healthUrl: new URL("health", httpBaseUrl).toString(),
    httpBaseUrl: httpBaseUrl.toString(),
    key: `${wsUrl.protocol}//${wsUrl.host}${basePath}`,
    muxUrl: muxUrl.toString(),
    relayUrl,
    statsUrl: new URL("stats", httpBaseUrl).toString(),
  };
}
