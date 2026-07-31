import type { IncomingMessage } from "node:http";

export interface TrustedProxy {
  v6: boolean;
  netBig: bigint;
  maskBits: number;
}

export interface TrustedProxyParseResult {
  proxies: TrustedProxy[];
  invalidEntries: string[];
}

export function parseTrustedProxies(
  input: string | undefined,
): TrustedProxyParseResult {
  const proxies: TrustedProxy[] = [];
  const invalidEntries: string[] = [];

  for (const raw of input?.split(",") ?? []) {
    const spec = raw.trim();
    if (!spec) continue;
    const parsed = parseCidr(spec);
    if (parsed) {
      proxies.push(parsed);
    } else {
      invalidEntries.push(spec);
    }
  }

  return { proxies, invalidEntries };
}

/**
 * Resolve a source address without trusting caller-controlled forwarding
 * headers unless the immediate peer is explicitly configured as a proxy.
 */
export function getClientIp(
  request: IncomingMessage,
  trustedProxies: TrustedProxy[],
): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  if (trustedProxies.length === 0 || !ipMatchesAny(peer, trustedProxies)) {
    return peer;
  }

  const header = request.headers["x-forwarded-for"];
  const chain = Array.isArray(header) ? header.join(",") : header;
  if (!chain) return peer;

  const entries = chain
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate && !ipMatchesAny(candidate, trustedProxies)) {
      return candidate;
    }
  }

  return peer;
}

function ipMatchesAny(ip: string, networks: TrustedProxy[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;

  for (const network of networks) {
    if (network.v6 !== parsed.v6) continue;
    const totalBits = network.v6 ? 128 : 32;
    const hostBits = totalBits - network.maskBits;
    const mask =
      network.maskBits === 0
        ? 0n
        : ((1n << BigInt(network.maskBits)) - 1n) << BigInt(hostBits);
    if ((parsed.big & mask) === network.netBig) return true;
  }

  return false;
}

function parseCidr(spec: string): TrustedProxy | null {
  const slash = spec.indexOf("/");
  const ipPart = slash === -1 ? spec : spec.slice(0, slash);
  const maskPart = slash === -1 ? null : spec.slice(slash + 1);
  const ip = parseIp(ipPart);
  if (!ip) return null;

  const totalBits = ip.v6 ? 128 : 32;
  const maskBits =
    maskPart === null ? totalBits : Number.parseInt(maskPart, 10);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > totalBits) {
    return null;
  }

  const hostBits = totalBits - maskBits;
  const mask =
    maskBits === 0
      ? 0n
      : ((1n << BigInt(maskBits)) - 1n) << BigInt(hostBits);
  return { v6: ip.v6, netBig: ip.big & mask, maskBits };
}

function parseIp(value: string): { big: bigint; v6: boolean } | null {
  const stripped = value.includes("%")
    ? value.slice(0, value.indexOf("%"))
    : value;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(
    stripped,
  );
  if (mapped?.[1]) return parseIpv4(mapped[1]);
  if (stripped.includes(":")) return parseIpv6(stripped);
  return parseIpv4(stripped);
}

function parseIpv4(value: string): { big: bigint; v6: false } | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  let big = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    big = (big << 8n) | BigInt(number);
  }

  return { big, v6: false };
}

function parseIpv6(value: string): { big: bigint; v6: true } | null {
  const doubleColon = value.indexOf("::");
  let parts: string[];

  if (doubleColon === -1) {
    parts = value.split(":");
    if (parts.length !== 8) return null;
  } else {
    if (value.indexOf("::", doubleColon + 1) !== -1) return null;
    const head = value.slice(0, doubleColon);
    const tail = value.slice(doubleColon + 2);
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 1) return null;
    parts = [
      ...headParts,
      ...new Array<string>(missing).fill("0"),
      ...tailParts,
    ];
  }

  let big = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    big = (big << 16n) | BigInt(Number.parseInt(part, 16));
  }

  return { big, v6: true };
}
