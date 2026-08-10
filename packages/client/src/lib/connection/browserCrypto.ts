/**
 * Browser-only `crypto` boundary for tssrp6a.
 *
 * The dependency probes Node's `crypto` module even though the browser client
 * requires Web Crypto. Pointing that probe here keeps Node built-ins out of the
 * browser bundle while preserving tssrp6a's secure-context failure behavior.
 */
export const webcrypto = globalThis.crypto;

export function createHash(): never {
  throw new Error("Node crypto hashing is unavailable in the browser client");
}

export function randomFillSync(): never {
  throw new Error(
    "Node crypto randomness is unavailable in the browser client",
  );
}
