import { useCallback, useMemo } from "react";
import { type RemoteExecutorTestResult, api } from "../api/client";
import { useServerSettings } from "./useServerSettings";

/**
 * Hook to fetch and manage remote executors configuration.
 *
 * Returns:
 * - executors: Array of SSH host aliases
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh the list
 * - addExecutor: Add a new executor and optionally test it first
 * - removeExecutor: Remove an executor from the list
 * - testExecutor: Test SSH connection to an executor
 */
export function useRemoteExecutors() {
  const { settings, isLoading, error, updateSetting, refetch } =
    useServerSettings();
  const executors = settings?.remoteExecutors ?? [];
  const hookError = useMemo(() => (error ? new Error(error) : null), [error]);

  const addExecutor = useCallback(
    async (host: string): Promise<void> => {
      if (!host.trim()) return;
      const trimmedHost = host.trim();
      await updateSetting("remoteExecutors", [
        ...executors.filter((executor) => executor !== trimmedHost),
        trimmedHost,
      ]);
    },
    [executors, updateSetting],
  );

  const removeExecutor = useCallback(
    async (host: string): Promise<void> => {
      await updateSetting(
        "remoteExecutors",
        executors.filter((executor) => executor !== host),
      );
    },
    [executors, updateSetting],
  );

  const replaceExecutors = useCallback(
    async (hosts: string[]): Promise<void> => {
      await updateSetting("remoteExecutors", hosts);
    },
    [updateSetting],
  );

  const testExecutor = useCallback(
    async (host: string): Promise<RemoteExecutorTestResult> => {
      return api.testRemoteExecutor(host);
    },
    [],
  );

  return {
    executors,
    loading: isLoading && settings === null,
    error: hookError,
    refetch,
    addExecutor,
    removeExecutor,
    replaceExecutors,
    testExecutor,
  };
}
