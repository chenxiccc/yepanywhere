import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { isNonRetryableError } from "../lib/connection/types";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import {
  createManagedStream,
  type ManagedStream,
  type ManagedStreamEvent,
  SERVER_PUSH_INACTIVITY_TIMEOUT_MS,
} from "../lib/transport";
import {
  getStreamingEnabled,
  subscribeStreamingEnabled,
} from "./useStreamingEnabled";

interface UseSessionStreamOptions {
  onMessage: (data: { eventType: string; [key: string]: unknown }) => void;
  onError?: (error: Event) => void;
  onOpen?: () => void;
}

function summarizeStreamPayload(
  eventType: string,
  data: unknown,
): Record<string, unknown> {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return {
    eventType,
    sdkType: typeof record.type === "string" ? record.type : undefined,
    subtype: typeof record.subtype === "string" ? record.subtype : undefined,
    role: typeof record.role === "string" ? record.role : undefined,
    state: typeof record.state === "string" ? record.state : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    tempId: typeof record.tempId === "string" ? record.tempId : undefined,
    deferredCount: Array.isArray(record.messages)
      ? record.messages.length
      : undefined,
  };
}

export function useSessionStream(
  sessionId: string | null,
  options: UseSessionStreamOptions,
) {
  const [connected, setConnected] = useState(false);
  const runtime = useCurrentSourceRuntime();
  const wantsLiveDeltas = useSyncExternalStore(
    subscribeStreamingEnabled,
    getStreamingEnabled,
    () => true,
  );
  const streamRef = useRef<ManagedStream | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Force reconnect (e.g., after process restart)
  const reconnect = useCallback(() => {
    if (!sessionId) return;
    logSessionUiTrace("session-stream-reconnect-requested", { sessionId });
    setConnected(false);
    streamRef.current?.restart({ delayMs: 50 });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      logSessionUiTrace("session-stream-disabled");
      setConnected(false);
      return undefined;
    }

    const transport = runtime.transport;
    const stream = createManagedStream(
      transport,
      {
        subscribe: ({ transport, handlers, lastEventId }) => {
          logSessionUiTrace("session-stream-subscribe", {
            sessionId,
            lastEventId: lastEventId ?? lastEventIdRef.current ?? null,
            wantsLiveDeltas,
          });
          return transport.subscribeSession(
            sessionId,
            handlers,
            lastEventId ?? lastEventIdRef.current ?? undefined,
            { wantsLiveDeltas },
          );
        },
        captureEventId: (event) =>
          event.eventType === "heartbeat" ? undefined : event.eventId,
        onEvent: (event: ManagedStreamEvent) => {
          if (event.eventType !== "heartbeat") {
            logSessionUiTrace("session-stream-event", {
              sessionId,
              eventId: event.eventId ?? null,
              ...summarizeStreamPayload(event.eventType, event.data),
            });
            if (event.eventId) {
              lastEventIdRef.current = event.eventId;
            }
          }
          optionsRef.current.onMessage({
            ...(event.data as Record<string, unknown>),
            eventType: event.eventType,
          });
        },
        onOpen: () => {
          logSessionUiTrace("session-stream-open", { sessionId });
          setConnected(true);
          optionsRef.current.onOpen?.();
        },
        onError: (error) => {
          logSessionUiTrace("session-stream-error", {
            sessionId,
            message: error.message,
            nonRetryable: isNonRetryableError(error),
          });
          setConnected(false);
          optionsRef.current.onError?.(new Event("error"));
          if (isNonRetryableError(error)) {
            console.warn(
              "[useSessionStream] Non-retryable error, not reconnecting:",
              error.message,
            );
          }
        },
        onClose: (error) => {
          logSessionUiTrace("session-stream-close", {
            sessionId,
            message: error?.message,
          });
          setConnected(false);
        },
      },
      {
        inactivityTimeoutMs: SERVER_PUSH_INACTIVITY_TIMEOUT_MS,
      },
    );
    streamRef.current = stream;
    const unsubscribe = stream.subscribe(() => {
      setConnected(stream.getSnapshot().connected);
    });
    setConnected(stream.getSnapshot().connected);

    return () => {
      unsubscribe();
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
      stream.close();
    };
  }, [runtime.transport, sessionId, wantsLiveDeltas]);

  return { connected, reconnect };
}
