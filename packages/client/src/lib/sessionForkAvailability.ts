import {
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  type ServerCapabilitySource,
  serverHasCapability,
} from "@yep-anywhere/shared";

/**
 * Unified Clone/direct Fork is optional and must make no request to an older
 * server or a provider without a real transcript-fork primitive.
 */
export function supportsUnifiedSessionFork(
  version: ServerCapabilitySource | null | undefined,
  providerSupportsFork: boolean | null | undefined,
): boolean {
  return (
    providerSupportsFork === true &&
    serverHasCapability(version, SESSION_FORK_TURN_INTENTS_CAPABILITY)
  );
}
