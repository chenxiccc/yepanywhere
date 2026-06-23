/**
 * WebSocket 准入/认证策略，与 SRP 传输密钥状态分离
 * WebSocket admission/auth policy is distinct from SRP transport key state.
 *
 * - Policy answers: "What level of auth is required for this connection?"
 * - SRP transport state answers: "Has this connection established an SRP key?"
 */

export type WsConnectionPolicy =
  | "local_unrestricted"
  | "local_cookie_trusted"
  | "srp_required";

export interface WsConnectionPolicyInput {
  remoteAccessEnabled: boolean;
  hasSessionCookieAuth: boolean;
  isRelayConnection: boolean;
  isLoopbackConnection: boolean;
  /**
   * 请求的 hostname 是否在用户允许的 hostname 白名单中
   * Whether the request hostname is in the user's allowed hostname allowlist.
   * 当用户在 Local Access 设置中明确信任某个域名（如 Cloudflare Tunnel 域名），
   * 应视为本地可信连接，无需额外 SRP 加密。
   */
  isAllowedHostname: boolean;
}

/**
 * 根据连接上下文推导 WebSocket 准入策略
 * Derive websocket admission policy from connection context.
 *
 * 信任层级（从高到低）：
 * 1. 中继连接 → 强制 SRP（始终加密）
 * 2. 远程访问关闭 → 本地放行（无需认证）
 * 3. 有 cookie 会话 → 本地信任
 * 4. TCP 回环地址 → 本地放行
 * 5. 用户允许的 hostname → 本地放行（用户明确信任该域名）
 * 6. 其他 → 强制 SRP
 */
export function deriveWsConnectionPolicy(
  input: WsConnectionPolicyInput,
): WsConnectionPolicy {
  if (input.isRelayConnection) {
    return "srp_required";
  }

  if (!input.remoteAccessEnabled) {
    return "local_unrestricted";
  }

  if (input.hasSessionCookieAuth) {
    return "local_cookie_trusted";
  }

  if (input.isLoopbackConnection) {
    return "local_unrestricted";
  }

  // 用户在 Local Access 设置中明确允许的 hostname，视为可信
  // Hostname explicitly allowed by user in Local Access settings is trusted
  if (input.isAllowedHostname) {
    return "local_unrestricted";
  }

  return "srp_required";
}

export function isPolicyTrustedWithoutSrp(policy: WsConnectionPolicy): boolean {
  return policy === "local_unrestricted" || policy === "local_cookie_trusted";
}

export function isPolicySrpRequired(policy: WsConnectionPolicy): boolean {
  return policy === "srp_required";
}