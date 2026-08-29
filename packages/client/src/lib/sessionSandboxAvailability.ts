import {
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
  type SessionSandboxAvailability,
  serverHasCapability,
} from "@yep-anywhere/shared";

export interface SessionSandboxAvailabilitySource {
  capabilities?: readonly string[];
  sessionSandboxing?: SessionSandboxAvailability;
}

/**
 * Require both the runtime-status contract and an actively usable host
 * backend. Intermediate development servers advertised only the protocol
 * capability on unsupported hosts, so that legacy shape must stay hidden.
 */
export function serverHasAvailableSessionSandbox(
  source: SessionSandboxAvailabilitySource | null | undefined,
): boolean {
  return (
    serverHasCapability(source, SESSION_SANDBOXING_STATUS_CAPABILITY) &&
    serverHasCapability(source, SESSION_SANDBOXING_CAPABILITY) &&
    serverHasCapability(source, SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY) &&
    source?.sessionSandboxing?.state === "available"
  );
}
