import type {
  SecurityClientAuthenticationMethod,
  SecurityClientTransport,
} from "@yep-anywhere/shared";

export interface AuthenticatedSrpTransportContext {
  kind: "srp";
  username: string;
  sessionId: string;
  transportNonce: string;
  authenticationMethod: Extract<
    SecurityClientAuthenticationMethod,
    "srp-full" | "srp-resume"
  >;
  transport: Extract<SecurityClientTransport, "direct" | "relay">;
  connectionId: string;
  peerAddress?: string;
  closeConnection: () => void;
  closeAfterResponse: () => void;
  deferAfterResponse: (task: () => Promise<void> | void) => void;
}

/**
 * Private request environment populated only for an established SRP tunnel.
 * External headers and trusted-local/cookie sockets cannot manufacture it.
 */
export const AUTHENTICATED_SRP_TRANSPORT = Symbol(
  "authenticated-srp-transport",
);

export function getAuthenticatedSrpTransport(
  env: unknown,
): AuthenticatedSrpTransportContext | null {
  if (!env || typeof env !== "object") return null;
  const context = (
    env as { [AUTHENTICATED_SRP_TRANSPORT]?: AuthenticatedSrpTransportContext }
  )[AUTHENTICATED_SRP_TRANSPORT];
  return context?.kind === "srp" ? context : null;
}
