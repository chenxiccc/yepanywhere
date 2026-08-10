/** Build identity sent during client/server capability negotiation. */
export function getClientVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim()
    ? __APP_VERSION__.trim()
    : "unknown";
}
