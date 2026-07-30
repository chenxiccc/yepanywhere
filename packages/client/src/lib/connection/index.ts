export type {
  Connection,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
export {
  WebSocketCloseError,
  RelayReconnectRequiredError,
  SubscriptionError,
  isNonRetryableError,
  NON_RETRYABLE_CLOSE_CODES,
} from "./types";
export {
  ConnectionManager,
  type ConnectionState,
  type ConnectionManagerConfig,
  type ConnectionManagerStartOptions,
  type ReconnectFn,
  type SendPingFn,
  type TimerInterface,
  type VisibilityInterface,
} from "./ConnectionManager";
export { WebSocketConnection } from "./WebSocketConnection";
export type { SecureConnectionSocket } from "./SecureConnectionSocket";
// SecureConnection is NOT re-exported here to avoid eagerly loading tssrp6a,
// which crashes in non-secure contexts (HTTP on LAN IPs) because crypto.subtle
// is unavailable. Import directly from "./SecureConnection" where needed.

/**
 * Check if this is the remote client build.
 *
 * The remote client is a statically-built version that MUST use SecureConnection
 * for all API requests. This is determined at build time via VITE_IS_REMOTE_CLIENT.
 */
export function isRemoteClient(): boolean {
  return import.meta.env.VITE_IS_REMOTE_CLIENT === true;
}
