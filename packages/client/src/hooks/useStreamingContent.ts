import { getModelContextWindow } from "@yep-anywhere/shared";
import { useCallback, useRef } from "react";
import {
  isBrowserDebugPerformanceRecording,
  recordBrowserDebugPerformanceMetric,
} from "../lib/browserDebugPerformance";
import type { ContentBlock, Message } from "../types";
import { getStreamingEnabled } from "./useStreamingEnabled";

/** Adaptive bounds for batching streaming UI updates */
const STREAMING_UPDATE_BASE_MS = 100;
const STREAMING_UPDATE_MAX_MS = 750;
const STREAMING_FLUSH_BUDGET_MS = 16;
const STREAMING_BURST_EVENT_THRESHOLD = 40;

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Callbacks for streaming markdown events (augment/pending from SSE) */
export interface StreamingMarkdownCallbacks {
  onAugment?: (augment: {
    blockIndex: number;
    html: string;
    type: string;
    messageId?: string;
  }) => void;
  onPending?: (pending: { html: string }) => void;
  onStreamEnd?: () => void;
  setCurrentMessageId?: (messageId: string | null) => void;
  captureHtml?: () => string | null;
}

/** Context usage info for subagent progress tracking */
export interface ContextUsage {
  inputTokens: number;
  percentage: number;
}

/** Options for useStreamingContent hook */
export interface UseStreamingContentOptions {
  /** Called when a streaming message needs to be updated in state */
  onUpdateMessage: (message: Message, agentId?: string) => void;
  /** Streaming markdown callbacks (passed through) */
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks;
  /** Callback when toolUseId→agentId mapping is discovered */
  onToolUseMapping?: (toolUseId: string, agentId: string) => void;
  /** Callback for agent context usage updates */
  onAgentContextUsage?: (agentId: string, usage: ContextUsage) => void;
  /** Fallback context window size when stream metadata doesn't include one */
  contextWindowSize?: number;
}

/** Result from useStreamingContent hook */
export interface UseStreamingContentResult {
  /** Process a stream_event SSE message. Returns true if handled. */
  handleStreamEvent: (data: Record<string, unknown>) => boolean;
  /** Clear all streaming state (called when assistant message arrives) */
  clearStreaming: () => void;
  /** Cleanup function for useEffect (clears timers) */
  cleanup: () => void;
  /** Get the current streaming agent ID (for routing assistant messages) */
  getCurrentAgentId: () => string | null;
}

/** Internal streaming state for a message */
interface StreamingState {
  blocks: ContentBlock[];
  isStreaming: boolean;
  agentId?: string;
  partialInputJson: Map<number, string>;
}

/**
 * Hook for managing streaming content accumulation from SSE stream_event messages.
 *
 * This hook handles:
 * - Accumulating content blocks from streaming API events
 * - Throttling UI updates to avoid overwhelming React with re-renders
 * - Routing subagent streams via agentId
 * - Notifying streaming markdown context of updates
 */
export function useStreamingContent(
  options: UseStreamingContentOptions,
): UseStreamingContentResult {
  const {
    onUpdateMessage,
    streamingMarkdownCallbacks,
    onToolUseMapping,
    onAgentContextUsage,
    contextWindowSize: defaultContextWindowSize,
  } = options;

  // Streaming state: accumulates content from stream_event messages
  // Key is the message uuid, value is the accumulated content blocks
  const streamingContentRef = useRef<Map<string, StreamingState>>(new Map());

  // Track current streaming message ID (from message_start event)
  // Each stream_event has its own uuid, but they all belong to the same message
  const currentStreamingIdRef = useRef<string | null>(null);

  // Track current streaming agentId (if this is a subagent stream)
  const currentStreamingAgentIdRef = useRef<string | null>(null);

  // Throttle streaming UI updates to avoid overwhelming React with re-renders
  // Data accumulates in streamingContentRef immediately, but state updates are batched
  const streamingThrottleRef = useRef<{
    quietTimer: ReturnType<typeof setTimeout> | null;
    deadlineTimer: ReturnType<typeof setTimeout> | null;
    dirtySinceMs: number | null;
    deadlineAtMs: number | null;
    pendingIds: Set<string>;
    pendingEventCount: number;
    intervalMs: number;
  }>({
    quietTimer: null,
    deadlineTimer: null,
    dirtySinceMs: null,
    deadlineAtMs: null,
    pendingIds: new Set(),
    pendingEventCount: 0,
    intervalMs: STREAMING_UPDATE_BASE_MS,
  });
  const flushStreamingUpdatesRef = useRef<() => void>(() => {});

  // Update messages with streaming content
  // Creates or updates a streaming placeholder message with accumulated content
  const updateStreamingMessage = useCallback(
    (messageId: string) => {
      const streaming = streamingContentRef.current.get(messageId);
      if (!streaming) return;

      const streamingMessage: Message = {
        id: messageId,
        type: "assistant",
        role: "assistant",
        message: {
          role: "assistant",
          content: streaming.blocks,
        },
        _isStreaming: true,
        _source: "sdk",
      };

      // Call the update callback with optional agentId for routing
      onUpdateMessage(streamingMessage, streaming.agentId);
    },
    [onUpdateMessage],
  );

  const tuneStreamingInterval = useCallback(
    (durationMs: number, eventCount: number) => {
      const throttle = streamingThrottleRef.current;
      if (
        durationMs > STREAMING_FLUSH_BUDGET_MS ||
        eventCount > STREAMING_BURST_EVENT_THRESHOLD
      ) {
        throttle.intervalMs = Math.min(
          STREAMING_UPDATE_MAX_MS,
          Math.max(200, Math.ceil(throttle.intervalMs * 1.5)),
        );
        return;
      }

      if (durationMs < STREAMING_FLUSH_BUDGET_MS / 2 && eventCount <= 8) {
        throttle.intervalMs = Math.max(
          STREAMING_UPDATE_BASE_MS,
          Math.floor(throttle.intervalMs * 0.8),
        );
      }
    },
    [],
  );

  const cancelStreamingTimers = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    if (throttle.quietTimer) {
      clearTimeout(throttle.quietTimer);
      throttle.quietTimer = null;
    }
    if (throttle.deadlineTimer) {
      clearTimeout(throttle.deadlineTimer);
      throttle.deadlineTimer = null;
    }
    throttle.dirtySinceMs = null;
    throttle.deadlineAtMs = null;
  }, []);

  const scheduleStreamingFlush = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    const flush = () => flushStreamingUpdatesRef.current();
    const scheduledAtMs = nowMs();
    throttle.dirtySinceMs ??= scheduledAtMs;

    if (throttle.quietTimer) {
      clearTimeout(throttle.quietTimer);
    }
    throttle.quietTimer = setTimeout(flush, throttle.intervalMs);

    // The quiet timer follows the newest delta. This deadline follows the
    // oldest unpublished delta, so a continuous burst cannot defer rendering
    // forever. Recompute it in place when the adaptive cadence changes; moving
    // a deadline behind now produces an immediate timer rather than starvation.
    const deadlineAtMs =
      throttle.dirtySinceMs + Math.max(200, throttle.intervalMs);
    if (throttle.deadlineAtMs !== deadlineAtMs) {
      if (throttle.deadlineTimer) {
        clearTimeout(throttle.deadlineTimer);
      }
      throttle.deadlineAtMs = deadlineAtMs;
      throttle.deadlineTimer = setTimeout(
        flush,
        Math.max(0, deadlineAtMs - scheduledAtMs),
      );
    }
  }, []);

  const flushStreamingUpdates = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    cancelStreamingTimers();
    if (throttle.pendingIds.size === 0) {
      throttle.pendingEventCount = 0;
      return;
    }

    const pendingIds = [...throttle.pendingIds];
    const eventCount = throttle.pendingEventCount;
    throttle.pendingIds.clear();
    throttle.pendingEventCount = 0;

    const startMs = nowMs();
    for (const id of pendingIds) {
      updateStreamingMessage(id);
    }
    const durationMs = nowMs() - startMs;
    tuneStreamingInterval(durationMs, eventCount);
    if (isBrowserDebugPerformanceRecording()) {
      recordBrowserDebugPerformanceMetric("streaming-content.flush", {
        durationMs,
      });
      recordBrowserDebugPerformanceMetric("streaming-content.flushed-event", {
        count: eventCount,
        category: pendingIds.length === 1 ? "one-message" : "multi-message",
      });
    }

    // An update callback may synchronously accept more stream data. Re-arm from
    // the remaining dirty set instead of requiring a later event to notice it.
    if (throttle.pendingIds.size > 0) {
      scheduleStreamingFlush();
    }
  }, [
    cancelStreamingTimers,
    scheduleStreamingFlush,
    tuneStreamingInterval,
    updateStreamingMessage,
  ]);
  flushStreamingUpdatesRef.current = flushStreamingUpdates;

  // Batches rapid deltas behind one resettable quiet timer and one non-resetting
  // maximum-age timer. Slow devices naturally move toward larger chunks.
  const throttledUpdateStreamingMessage = useCallback(
    (messageId: string) => {
      const throttle = streamingThrottleRef.current;
      throttle.pendingIds.add(messageId);
      throttle.pendingEventCount += 1;
      scheduleStreamingFlush();
    },
    [scheduleStreamingFlush],
  );

  // Clear all accumulated streaming state and pending UI flushes.
  const clearStreaming = useCallback(() => {
    const throttle = streamingThrottleRef.current;
    cancelStreamingTimers();
    throttle.pendingIds.clear();
    throttle.pendingEventCount = 0;
    throttle.intervalMs = STREAMING_UPDATE_BASE_MS;
    streamingContentRef.current.clear();
    currentStreamingIdRef.current = null;
    currentStreamingAgentIdRef.current = null;
  }, [cancelStreamingTimers]);

  // Process a stream_event SSE message
  // Returns true if the event was handled, false if it should be processed elsewhere
  const handleStreamEvent = useCallback(
    (data: Record<string, unknown>): boolean => {
      const msgType = data.type as string | undefined;
      if (msgType !== "stream_event") {
        return false;
      }

      if (!getStreamingEnabled()) {
        clearStreaming();
        return true;
      }

      const event = data.event as Record<string, unknown> | undefined;
      if (!event) return true; // Handled but no event data

      const eventType = event.type as string | undefined;
      if (isBrowserDebugPerformanceRecording()) {
        const delta = event.delta as Record<string, unknown> | undefined;
        const contentBlock = event.content_block as
          | Record<string, unknown>
          | undefined;
        const text =
          typeof delta?.text === "string"
            ? delta.text
            : typeof delta?.thinking === "string"
              ? delta.thinking
              : typeof contentBlock?.text === "string"
                ? contentBlock.text
                : typeof contentBlock?.thinking === "string"
                  ? contentBlock.thinking
                  : "";
        recordBrowserDebugPerformanceMetric("streaming-content.event", {
          category: eventType ?? "unknown",
          chars: text.length,
        });
      }

      // Check if this is a subagent stream (marked by server via markSubagent)
      // Legacy SDK: uses parentToolUseId as routing key
      // SDK 0.2.76+: uses agentId directly (no parentToolUseId)
      const parentToolUseId =
        typeof data.parentToolUseId === "string"
          ? data.parentToolUseId
          : undefined;
      const providerAgentId =
        typeof data.agentId === "string" ? data.agentId : undefined;
      const isSubagentStream =
        data.isSubagent && (parentToolUseId || providerAgentId);
      const streamAgentId = isSubagentStream
        ? (providerAgentId ?? parentToolUseId)
        : undefined;

      // Legacy streams use the parent tool call as their child key. Current
      // streams carry the provider child ID; only register a Task mapping when
      // the stream also identifies the parent tool call.
      if (parentToolUseId && streamAgentId && onToolUseMapping) {
        onToolUseMapping(parentToolUseId, streamAgentId);
      }

      // Handle message_start to capture the message ID for this streaming response
      // Each stream_event has its own uuid, but they all belong to the same API message
      if (eventType === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.id) {
          currentStreamingIdRef.current = message.id as string;
          // Also track if this is a subagent stream
          currentStreamingAgentIdRef.current = streamAgentId ?? null;
          // Notify streaming markdown context of new message
          streamingMarkdownCallbacks?.setCurrentMessageId?.(
            message.id as string,
          );

          // Extract context usage for subagent progress tracking
          // Note: We only update subagent context usage from message_start, not main session.
          // Main session context usage comes from the API (which reads from JSONL after
          // the assistant message is complete with full usage data).
          if (streamAgentId && onAgentContextUsage) {
            const usage = message.usage as
              | { input_tokens?: number }
              | undefined;
            if (usage?.input_tokens) {
              const inputTokens = usage.input_tokens;
              const model =
                typeof message.model === "string" ? message.model : undefined;
              const modelContextWindow =
                typeof message.model_context_window === "number"
                  ? message.model_context_window
                  : undefined;
              const contextWindow =
                modelContextWindow && modelContextWindow > 0
                  ? modelContextWindow
                  : model
                    ? getModelContextWindow(model)
                    : (defaultContextWindowSize ??
                      getModelContextWindow(undefined));
              const percentage = (inputTokens / contextWindow) * 100;
              onAgentContextUsage(streamAgentId, { inputTokens, percentage });
            }
          }
        }
        return true;
      }

      // Use the captured message ID, or fall back to generating one
      const streamingId =
        currentStreamingIdRef.current ?? `stream-${Date.now()}`;
      // Use tracked agentId, falling back to current message's agentId
      const agentId = currentStreamingAgentIdRef.current ?? streamAgentId;

      // Handle different stream event types
      if (eventType === "content_block_start") {
        // New content block starting
        const index = event.index as number;
        const contentBlock = event.content_block as Record<
          string,
          unknown
        > | null;
        if (contentBlock) {
          const streaming: StreamingState = streamingContentRef.current.get(
            streamingId,
          ) ?? {
            blocks: [],
            isStreaming: true,
            agentId, // Track which agent this stream belongs to
            partialInputJson: new Map(),
          };
          // Ensure array is long enough
          while (streaming.blocks.length <= index) {
            streaming.blocks.push({ type: "text", text: "" });
          }
          // Preserve tool identity and input along with text/thinking fields. A
          // lossy projection here hides live tool activity until JSONL catch-up.
          streaming.blocks[index] = {
            ...contentBlock,
            type:
              typeof contentBlock.type === "string"
                ? contentBlock.type
                : "text",
          };
          streamingContentRef.current.set(streamingId, streaming);
          updateStreamingMessage(streamingId);
        }
      } else if (eventType === "content_block_delta") {
        // Content delta - append to existing block
        // Use throttled updates to avoid overwhelming React with re-renders
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown> | null;
        if (delta) {
          const streaming = streamingContentRef.current.get(streamingId);
          if (streaming?.blocks[index]) {
            const block = streaming.blocks[index];
            const deltaType = delta.type as string;
            let changed = false;
            if (deltaType === "text_delta" && typeof delta.text === "string") {
              block.text = (block.text ?? "") + delta.text;
              changed = delta.text.length > 0;
            } else if (
              deltaType === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              block.thinking = (block.thinking ?? "") + delta.thinking;
              changed = delta.thinking.length > 0;
            } else if (
              deltaType === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const partialJson =
                (streaming.partialInputJson.get(index) ?? "") +
                delta.partial_json;
              streaming.partialInputJson.set(index, partialJson);
              try {
                block.input = JSON.parse(partialJson);
                changed = true;
              } catch {
                // Partial tool input becomes publishable when a later delta
                // completes the JSON value.
              }
            }
            if (changed) {
              throttledUpdateStreamingMessage(streamingId);
            }
          }
        }
      } else if (eventType === "content_block_stop") {
        // Block complete - nothing special needed, final message will replace
      } else if (eventType === "message_stop") {
        flushStreamingUpdates();
        // Message complete - clean up streaming ref state
        // DON'T clear currentStreamingIdRef here - we need it to remove the
        // streaming placeholder when the final assistant message arrives
        streamingContentRef.current.delete(streamingId);
        // Notify streaming markdown context that stream has ended
        streamingMarkdownCallbacks?.onStreamEnd?.();
      }

      return true; // Event was handled
    },
    [
      updateStreamingMessage,
      throttledUpdateStreamingMessage,
      flushStreamingUpdates,
      clearStreaming,
      streamingMarkdownCallbacks,
      onToolUseMapping,
      onAgentContextUsage,
      defaultContextWindowSize,
    ],
  );

  // Get the current streaming agent ID (for routing assistant messages)
  const getCurrentAgentId = useCallback(() => {
    return currentStreamingAgentIdRef.current;
  }, []);

  // Cleanup function for useEffect (clears timers)
  const cleanup = useCallback(() => {
    cancelStreamingTimers();
    streamingThrottleRef.current.pendingIds.clear();
    streamingThrottleRef.current.pendingEventCount = 0;
  }, [cancelStreamingTimers]);

  return {
    handleStreamEvent,
    clearStreaming,
    cleanup,
    getCurrentAgentId,
  };
}
