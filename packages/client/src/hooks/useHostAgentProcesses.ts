import {
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  serverHasCapability,
  type HostAgentProcessObservation,
  type HostAgentProcessesResponse,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { isRemoteClient } from "../lib/connection";
import { useServerSettings } from "./useServerSettings";
import { useVersion } from "./useVersion";

const HOST_PROCESS_POLL_MS = 5_000;

export interface UseHostAgentProcessesResult {
  enabled: boolean;
  supported: boolean | null;
  observations: readonly HostAgentProcessObservation[];
  loading: boolean;
  error: boolean;
}

/**
 * Poll host process facts only while the Agents page owns this hook and the
 * document is visible. The permanent capability gate prevents any request to
 * older servers.
 */
export function useHostAgentProcesses(): UseHostAgentProcessesResult {
  const { version } = useVersion();
  const { settings } = useServerSettings();
  const runtime = useCurrentSourceRuntime();
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const capabilityPresent = serverHasCapability(
    version,
    HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  );
  const enabled =
    capabilityPresent && (settings?.hostProcessObservabilityEnabled ?? true);
  const [observations, setObservations] = useState<
    readonly HostAgentProcessObservation[]
  >([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled || !ready) {
      setObservations([]);
      setSupported(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let firstRequest = true;

    const schedule = () => {
      if (cancelled || document.hidden) return;
      timer = window.setTimeout(() => void request(), HOST_PROCESS_POLL_MS);
    };

    const request = async () => {
      if (cancelled || document.hidden) return;
      if (firstRequest) setLoading(true);
      try {
        const response =
          await runtime.transport.fetch<HostAgentProcessesResponse>(
            "/host-agent-processes",
          );
        if (cancelled) return;
        firstRequest = false;
        setLoading(false);
        setError(false);
        setSupported(response.supported);
        setObservations(response.enabled ? response.observations : []);
        if (response.enabled && response.supported) schedule();
      } catch {
        if (cancelled) return;
        firstRequest = false;
        setLoading(false);
        setError(true);
        setObservations([]);
        schedule();
      }
    };

    const handleVisibilityChange = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (!document.hidden) void request();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void request();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, ready, runtime.transport]);

  return {
    enabled,
    supported,
    observations,
    loading,
    error,
  };
}
