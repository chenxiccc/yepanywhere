import { useMemo } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import type { ConnectionSpeechSocket } from "../lib/connection/types";

export interface SpeechSourceRuntime {
  relayTransport: boolean;
  relayedServerSpeechAvailable: boolean;
  openRelayedSpeechSocket?: () => Promise<ConnectionSpeechSocket>;
}

/** Speech capabilities of the currently selected YA source transport. */
export function useSpeechSourceRuntime(): SpeechSourceRuntime {
  const transport = useCurrentSourceRuntime().transport;
  const relayTransport = !transport.capabilities.sameOriginUrls;
  const speechChannel = transport.capabilities.speech;
  const openRelayedSpeechSocket = useMemo(() => {
    if (!relayTransport || !speechChannel) return undefined;
    return () => speechChannel.open();
  }, [relayTransport, speechChannel]);

  return useMemo(
    () => ({
      relayTransport,
      relayedServerSpeechAvailable: speechChannel !== undefined,
      openRelayedSpeechSocket,
    }),
    [relayTransport, speechChannel, openRelayedSpeechSocket],
  );
}
