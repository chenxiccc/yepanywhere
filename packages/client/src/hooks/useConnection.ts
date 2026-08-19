import { useMemo } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import type { Connection } from "../lib/connection";
import type { SourceTransport } from "../lib/transport";

/**
 * Deprecated compatibility shim. New feature code should use the current
 * source runtime's transport directly.
 */
export function useConnection(): Connection {
  const runtime = useCurrentSourceRuntime();
  return useMemo(
    () => createConnectionShim(runtime.transport),
    [runtime.transport],
  );
}

function createConnectionShim(transport: SourceTransport): Connection {
  return {
    mode: transport.kind === "secure" ? "secure" : "direct",
    fetch: (path, init) => transport.fetch(path, init),
    fetchBlob: (path) => transport.fetchBlob(path),
    subscribeSession: (sessionId, handlers, lastEventId, options) =>
      transport.subscribeSession(sessionId, handlers, lastEventId, options),
    subscribeActivity: (handlers) => transport.subscribeActivity(handlers),
    subscribeGlossary: (projectId, handlers) =>
      transport.subscribeGlossary(projectId, handlers),
    subscribeWorktree: (projectId, coverage, handlers) =>
      transport.subscribeWorktree(projectId, coverage, handlers),
    subscribeSessionWatch: (sessionId, handlers, options) =>
      transport.subscribeSessionWatch(sessionId, handlers, options),
    upload: (projectId, sessionId, file, options) =>
      transport.upload(projectId, sessionId, file, options),
    uploadStagedAttachment: (file, options) =>
      transport.uploadStagedAttachment(file, options),
    forceReconnect: () => transport.reconnect(),
    ...(transport.capabilities.device
      ? {
          sendMessage: (msg) => {
            try {
              const result = transport.capabilities.device?.send(msg);
              if (result) {
                void result.catch(() => {});
              }
            } catch {
              // Legacy fire-and-forget shim.
            }
          },
          onDeviceMessage: (handler) =>
            transport.capabilities.device?.onMessage(handler) ?? (() => {}),
        }
      : {}),
    ...(transport.capabilities.speech
      ? {
          openSpeechSocket: () => transport.capabilities.speech!.open(),
        }
      : {}),
  };
}
