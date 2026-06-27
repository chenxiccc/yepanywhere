import { useCallback, useEffect, useRef, useState } from "react";
import { type PaginationInfo, api } from "../api/client";
import {
  getMessageTimestampMs,
  hasEquivalentJsonlMessage,
  reconcileLinearMessages,
} from "../lib/linearMessageDedup";
import {
  findMessageIndexById,
  getMessageId,
  mergeJSONLMessages,
  mergeStreamMessage,
} from "../lib/mergeMessages";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import type {
  SessionCacheAdapter,
  SessionCacheEntry,
} from "../lib/sessionCache/sessionCacheStore";
import { getProvider } from "../providers/registry";
import { getStreamingEnabled } from "./useStreamingEnabled";
import type {
  AgentContent,
  AgentContentMap,
  Message,
  SessionMetadata,
  SessionStatus,
} from "../types";

// Re-export so existing `import { AgentContent, AgentContentMap } from "./useSessionMessages"`
// (and via useSession) keeps working. Canonical definition lives in types.ts.
// re-export，使既有的 `import { AgentContent, AgentContentMap } from "./useSessionMessages"`
// （以及经 useSession）仍可用。规范定义在 types.ts。
export type { AgentContent, AgentContentMap };


/** Result from initial session load */
export interface SessionLoadResult {
  session: SessionMetadata;
  status: SessionStatus;
  pendingInputRequest?: unknown;
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }> | null;
}

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
  // [ya-private] begin -- session load cache (private fork)
  /** Cache adapter bound to the server-side sessionLoadCacheEnabled flag.
   * When undefined or disabled, the hook takes the cold path (no cache). */
  // 绑定到服务端 sessionLoadCacheEnabled 开关的缓存适配器。
  // 为 undefined 或禁用时，hook 走冷路径（无缓存）。
  cacheAdapter?: SessionCacheAdapter;
  // [ya-private] end
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Session data from initial load */
  session: SessionMetadata | null;
  /** Set session data (for stream connected event) */
  setSession: React.Dispatch<React.SetStateAction<SessionMetadata | null>>;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Update agent content (for lazy loading) */
  setAgentContent: React.Dispatch<React.SetStateAction<AgentContentMap>>;
  /** Update toolUseToAgent mapping */
  setToolUseToAgent: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  /** Direct messages setter (for clearing streaming placeholders) */
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: () => Promise<void>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from compact-boundary-based loading */
  pagination: PaginationInfo | undefined;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Load the next chunk of older messages */
  loadOlderMessages: () => Promise<void>;
}

type SessionLoadCacheEnv = Pick<ImportMetaEnv, "DEV" | "VITE_SESSION_LOAD_CACHE">;

/**
 * Legacy dev-only env gate, retained for the dedicated unit test and as an
 * additional dev override. The production gate is the server-side
 * `sessionLoadCacheEnabled` setting threaded in via options.
 * 旧的 dev-only 环境开关，保留用于专属单测及作为额外的 dev 覆盖。
 * 生产环境的开关是经 options 透传的服务端 `sessionLoadCacheEnabled` 设置。
 */
export function isSessionLoadCacheEnabled(
  env: SessionLoadCacheEnv = import.meta.env,
): boolean {
  return env.DEV === true && env.VITE_SESSION_LOAD_CACHE === "true";
}

// [ya-private] Default no-op cache adapter used when the cache is disabled or
// before the caller injects one. Branch-free cold path.
// [ya-private] 缓存禁用或调用方未注入适配器时使用的默认 no-op 适配器。无分支冷路径。
const DEFAULT_NOOP_CACHE_ADAPTER: SessionCacheAdapter = {
  read: async () => null,
  write: async () => {},
};

function usesApproxMessageDedup(provider?: string): boolean {
  return getProvider(provider).capabilities.needsApproxMessageDedup;
}

// Options for the approx-dedup backstop. Codex tool messages dedup by call_id,
// so they are excluded here; the backstop keeps covering non-tool messages.
function approxDedupOptions(provider?: string): { excludeTools: boolean } {
  return {
    excludeTools:
      getProvider(provider).capabilities.approxDedupExcludesTools === true,
  };
}

function isDurableRecapOverlay(message: Message): boolean {
  return typeof message.yaRecapSource === "string";
}

/**
 * Find the id of the newest JSONL-sourced message.
 *
 * The incremental-fetch cursor (afterMessageId) must only advance over
 * rows actually delivered from JSONL. Live stream rows also land in the
 * array (and get persisted to the file), so cursoring on the array tail
 * lets streaming advance the cursor past JSONL rows that were never
 * fetched — permanently skipping them, including chain connector rows
 * (attachment, system/api_error) that only exist in JSONL. Over-fetching
 * is safe (merge dedupes by uuid); gaps are not.
 */
function findLastJsonlMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      (message._source ?? "sdk") === "jsonl" &&
      !isDurableRecapOverlay(message)
    ) {
      return getMessageId(message);
    }
  }
  return undefined;
}

function shouldSuppressLiveStreamingMessage(message: Message): boolean {
  return message._isStreaming === true && !getStreamingEnabled();
}

function clearStreamingMessages(messages: Message[]): Message[] {
  const filtered = messages.filter((message) => !message._isStreaming);
  return filtered.length === messages.length ? messages : filtered;
}

function isEmptyAssistantContent(message: Message): boolean {
  if (message.type !== "assistant") {
    return false;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }

    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type === "text") {
      return (
        typeof typedBlock.text !== "string" || typedBlock.text.trim() === ""
      );
    }
    if (typedBlock.type === "thinking") {
      return (
        typeof typedBlock.thinking !== "string" ||
        typedBlock.thinking.trim() === ""
      );
    }
    return false;
  });
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const {
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    onLoadComplete,
    onLoadError,
    cacheAdapter = DEFAULT_NOOP_CACHE_ADAPTER,
  } = options;

  // Core state. Initialized empty / loading: the persistent cache hydrates
  // asynchronously (see warm-hydration effect below) so we never block render
  // on an IndexedDB read. REST proceeds in parallel from mount.
  // 核心状态。初始化为空 / loading：持久化缓存异步 hydrate（见下方 warm-hydration
  // effect），因此绝不阻塞渲染等待 IndexedDB 读取。REST 从挂载即并行发起。
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentContent, setAgentContent] = useState<AgentContentMap>({});
  const [toolUseToAgent, setToolUseToAgent] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Buffering: queue stream messages until initial load completes
  const streamBufferRef = useRef<
    Array<
      | { type: "message"; msg: Message }
      | { type: "subagent"; msg: Message; agentId: string }
    >
  >([]);
  const initialLoadCompleteRef = useRef(false);

  // Track provider for DAG ordering decisions
  const providerRef = useRef<string | undefined>(undefined);

  // Track last message ID for incremental fetching
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  // Highest timestamp observed from persisted JSONL messages.
  // Used to suppress startup replay events that are already on disk.
  const maxPersistedTimestampMsRef = useRef<number>(Number.NEGATIVE_INFINITY);

  // [ya-private] begin -- ref mirrors + warm hydration ref (private fork)
  // Ref mirrors of state, so async callbacks (REST .then, hydration) can read
  // the latest values without re-subscribing. Updated by the [messages] effect
  // below and dedicated effects for agentContent / toolUseToAgent.
  // state 的 ref 镜像，使异步回调（REST .then、hydration）能读到最新值而无需
  // 重新订阅。由下方 [messages] effect 及 agentContent / toolUseToAgent 的
  // 专属 effect 更新。
  const messagesRef = useRef<Message[]>(messages);
  const agentContentRef = useRef<AgentContentMap>(agentContent);
  const toolUseToAgentRef = useRef<Map<string, string>>(toolUseToAgent);
  // Set by the warm-hydration effect when it paints from cache; read by the
  // REST .then to validate staleness and to source warmMessages for merging.
  // 由 warm-hydration effect 在从缓存绘制时设置；REST .then 读取它以校验过期、
  // 并作为 warmMessages 来源用于合并。
  const warmHydrationRef = useRef<SessionCacheEntry | null>(null);

  const updatePersistedTimestampWatermark = useCallback(
    (persistedMessages: Message[]) => {
      let maxMs = maxPersistedTimestampMsRef.current;
      for (const message of persistedMessages) {
        if (isDurableRecapOverlay(message)) {
          continue;
        }
        const ts = getMessageTimestampMs(message);
        if (ts !== null && ts > maxMs) {
          maxMs = ts;
        }
      }
      maxPersistedTimestampMsRef.current = maxMs;
    },
    [],
  );

  // Update lastMessageIdRef when messages change.
  // Cursor on the newest JSONL-sourced row, not the array tail (see
  // findLastJsonlMessageId).
  useEffect(() => {
    messagesRef.current = messages;
    const lastJsonlId = findLastJsonlMessageId(messages);
    if (lastJsonlId) {
      lastMessageIdRef.current = lastJsonlId;
    }
  }, [messages]);

  // Ref mirrors for agentContent / toolUseToAgent, so async callbacks (REST
  // .then, warm hydration, write-on-unmount) read the latest state.
  // agentContent / toolUseToAgent 的 ref 镜像，使异步回调（REST .then、
  // warm hydration、卸载时写入）能读到最新状态。
  useEffect(() => {
    agentContentRef.current = agentContent;
  }, [agentContent]);
  useEffect(() => {
    toolUseToAgentRef.current = toolUseToAgent;
  }, [toolUseToAgent]);
  // [ya-private] end -- ref mirrors + warm hydration ref

  // Process a stream message event.
  // When replaying buffered startup events for Codex, suppress entries that are
  // semantically identical to already-loaded JSONL messages but have different UUIDs.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const provider = providerRef.current;
      const isReplay = incoming.isReplay === true;
      const shouldApplyReplayDedupe =
        (fromBufferedReplay || isReplay) && usesApproxMessageDedup(provider);
      const incomingTimestampMs = getMessageTimestampMs(incoming);
      const isPersistedReplay =
        isReplay &&
        incomingTimestampMs !== null &&
        incomingTimestampMs <= maxPersistedTimestampMsRef.current;
      const suppressStreaming = shouldSuppressLiveStreamingMessage(incoming);

      setMessages((prev) => {
        if (suppressStreaming) {
          return clearStreamingMessages(prev);
        }

        // Replay history from the stream should not re-add messages that are
        // already persisted and loaded from JSONL.
        if (isPersistedReplay) {
          return prev;
        }

        if (shouldApplyReplayDedupe) {
          if (isEmptyAssistantContent(incoming)) {
            return prev;
          }
          if (
            hasEquivalentJsonlMessage(
              prev,
              incoming,
              approxDedupOptions(provider),
            )
          ) {
            return prev;
          }
        }

        const result = mergeStreamMessage(prev, incoming);
        return usesApproxMessageDedup(provider)
          ? reconcileLinearMessages(
              result.messages,
              approxDedupOptions(provider),
            )
          : result.messages;
      });
    },
    [],
  );

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      setAgentContent((prev) => {
        const existing = prev[agentId] ?? {
          messages: [],
          status: "running" as const,
        };
        if (shouldSuppressLiveStreamingMessage(incoming)) {
          const messages = clearStreamingMessages(existing.messages);
          if (messages === existing.messages) {
            return prev;
          }
          if (messages.length === 0 && existing.contextUsage === undefined) {
            const next = { ...prev };
            delete next[agentId];
            return next;
          }
          return {
            ...prev,
            [agentId]: {
              ...existing,
              messages,
            },
          };
        }
        const incomingId = getMessageId(incoming);
        if (findMessageIndexById(existing.messages, incomingId) !== -1) {
          return prev;
        }
        return {
          ...prev,
          [agentId]: {
            ...existing,
            messages: [...existing.messages, incoming],
            status: "running",
          },
        };
      });
    },
    [],
  );

  // Flush buffered stream messages after initial load
  const flushBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    streamBufferRef.current = [];
    for (const item of buffer) {
      if (item.type === "message") {
        processStreamMessage(item.msg, true);
      } else {
        processStreamSubagentMessage(item.msg, item.agentId);
      }
    }
  }, [processStreamMessage, processStreamSubagentMessage]);

  // Initial load. When a warm in-tab cache exists, the REST request is an
  // incremental refresh after the cached tail; merge that delta instead of
  // replacing the cached transcript.
  useEffect(() => {
    let cancelled = false;
    markReloadPerfPhase("session_initial_load_start", {
      projectId,
      sessionId,
      tailCompactions: 2,
      tailTurns,
      tailFrom,
    });
    initialLoadCompleteRef.current = false;
    streamBufferRef.current = [];
    // Reset to cold-start state. The persistent cache (if any) hydrates below.
    // 重置为冷启动状态。持久化缓存（若有）在下方 hydrate。
    maxPersistedTimestampMsRef.current = Number.NEGATIVE_INFINITY;
    providerRef.current = undefined;
    lastMessageIdRef.current = undefined;
    warmHydrationRef.current = null;
    setLoading(true);
    setAgentContent({});
    setToolUseToAgent(new Map());
    setSession(null);
    setPagination(undefined);

    // [ya-private] begin -- session cache hydration + staleness (private fork).
    // This entire initial-load effect is rewritten vs upstream to chain REST
    // after the IndexedDB cache read and validate staleness. Merge carefully.
    // [ya-private] 该 initial-load effect 相对上游已重写：将 REST 串在 IndexedDB
    // 缓存读取之后并校验过期。合并时请仔细处理。
    // Warm hydration: read the persistent cache and paint if it hits, THEN
    // issue the REST request. Chaining the REST call after the cache read
    // (a few ms for IndexedDB) lets REST use the cached lastMessageId as the
    // afterMessageId anchor, so reopen fetches only a small delta instead of
    // the full tail. Skipped entirely when the cache is disabled (REST runs
    // immediately via a resolved promise).
    // warm hydration：读取持久化缓存，命中则绘制，然后再发起 REST 请求。
    // 将 REST 调用串在缓存读取之后（IndexedDB 几毫秒），使 REST 能用缓存的
    // lastMessageId 作为 afterMessageId 锚点，从而重开时只拉取小增量而非全量尾部。
    // 缓存禁用时 adapter 为 no-op（read 返回 null），自然走冷路径。
    const hydrationPromise: Promise<void> = cacheAdapter
      .read(projectId, sessionId, tailTurns, tailFrom)
      .then((cached) => {
        if (cancelled || !cached) return;
        // REST hasn't run yet (we're still before the api.getSession call),
        // so paint the warm view and set the incremental anchor.
        // REST 尚未执行（仍在 api.getSession 调用之前），故绘制 warm 视图并设增量锚点。
        warmHydrationRef.current = cached;
        maxPersistedTimestampMsRef.current = cached.maxPersistedTimestampMs;
        providerRef.current = cached.session.provider;
        lastMessageIdRef.current = cached.lastMessageId;
        setMessages(cached.messages);
        setAgentContent(cached.agentContent);
        setToolUseToAgent(new Map(cached.toolUseToAgentEntries));
        setSession(cached.session);
        setPagination(cached.pagination);
        setLoading(false);
      })
      .catch(() => {
        // Swallow: fall back to cold load (lastMessageIdRef stays undefined).
        // 吞掉：回退冷加载（lastMessageIdRef 保持 undefined）。
      });

    // Apply a cold (non-warm) REST result: tag, dedup, set state, mark ready,
    // write cache. Shared by the initial cold load and the staleness-triggered
    // full tail reload. 使用返回结果（非 warm）：打标、去重、设状态、标记就绪、
    // 写缓存。初始冷载与过期触发的全量尾部重拉共用。
    const applyColdLoad = (
      data: Awaited<ReturnType<typeof api.getSession>>,
    ) => {
      setSession(data.session);
      providerRef.current = data.session.provider;
      const taggedMessages = data.messages.map((m) => ({
        ...m,
        _source: "jsonl" as const,
      }));
      updatePersistedTimestampWatermark(taggedMessages);
      const loadedMessages = usesApproxMessageDedup(data.session.provider)
        ? reconcileLinearMessages(
            taggedMessages,
            approxDedupOptions(data.session.provider),
          )
        : taggedMessages;
      setMessages(loadedMessages);
      setPagination(data.pagination);
      markReloadPerfPhase("session_initial_messages_state_queued", {
        messages: taggedMessages.length,
        totalMessages: loadedMessages.length,
        provider: data.session.provider,
      });
      const lastJsonlId = findLastJsonlMessageId(loadedMessages);
      if (lastJsonlId) {
        lastMessageIdRef.current = lastJsonlId;
      }
      initialLoadCompleteRef.current = true;
      warmHydrationRef.current = null;
      flushBuffer();
      setLoading(false);
      markReloadPerfPhase("session_initial_load_complete", {
        messages: taggedMessages.length,
      });
      cacheAdapter.write(
        projectId,
        sessionId,
        {
          messages: loadedMessages,
          session: data.session,
          pagination: data.pagination,
          agentContent: agentContentRef.current,
          toolUseToAgentEntries: Array.from(toolUseToAgentRef.current.entries()),
          lastMessageId: lastMessageIdRef.current,
          maxPersistedTimestampMs: maxPersistedTimestampMsRef.current,
        },
        tailTurns,
        tailFrom,
      );
      onLoadComplete?.({
        session: data.session,
        status: data.ownership,
        pendingInputRequest: data.pendingInputRequest,
        slashCommands: data.slashCommands,
      });
    };

    hydrationPromise
      .then(() => {
        if (cancelled) return;
        return api.getSession(projectId, sessionId, lastMessageIdRef.current, {
          tailCompactions: 2,
          tailTurns,
          tailFrom,
        });
      })
      .then((data) => {
        if (cancelled || !data) return;
        markReloadPerfPhase("session_initial_load_data_ready", {
          messages: data.messages.length,
          provider: data.session.provider,
          totalMessages: data.pagination?.totalMessageCount,
          hasOlderMessages: data.pagination?.hasOlderMessages,
        });

        // Staleness check (only when a warm hydration painted). Reuse this
        // already-sent incremental response — no extra metadata request.
        // A totalMessageCount mismatch means the session was compacted /
        // advanced elsewhere since the cache was written, so the cached
        // lastMessageId anchor is no longer reliable. Discard the warm view
        // (keep it visible to avoid a flash) and do a full tail reload.
        // 过期校验（仅当 warm hydration 已绘制时）。复用本次已发的增量响应 ——
        // 不额外发 metadata 请求。totalMessageCount 不一致意味着自缓存写入后
        // 会话在别处被 compact / 推进，缓存的 lastMessageId 锚点不再可靠。
        // 丢弃 warm 视图（保留可见以避免闪烁），发起全量尾部重拉。
        const warm = warmHydrationRef.current;
        if (
          warm &&
          data.pagination?.totalMessageCount !== undefined &&
          warm.cachedTotalMessageCount !== undefined &&
          data.pagination.totalMessageCount !== warm.cachedTotalMessageCount
        ) {
          warmHydrationRef.current = null;
          // Keep warm messages visible until the full tail lands; signal activity.
          // 保留 warm 消息可见直到全量尾部返回；示意活动进行中。
          setLoadingOlder(true);
          api
            .getSession(projectId, sessionId, undefined, {
              tailCompactions: 2,
              tailTurns,
              tailFrom,
            })
            .then((fullData) => {
              if (cancelled) return;
              setLoadingOlder(false);
              applyColdLoad(fullData);
            })
            .catch((err) => {
              if (cancelled) return;
              setLoadingOlder(false);
              markReloadPerfPhase("session_initial_load_error", {
                message: err instanceof Error ? err.message : String(err),
              });
              setLoading(false);
              onLoadError?.(err);
            });
          return;
        }

        // No staleness, or no warm hydration. Merge incremental delta against
        // the warm view if present, else cold-apply.
        // 无过期，或无 warm hydration。命中 warm 则合并增量 delta，否则冷加载应用。
        const warmMessages = warm?.messages;
        const shouldMergeWarmDelta =
          warmMessages !== undefined && Boolean(lastMessageIdRef.current);
        if (shouldMergeWarmDelta) {
          setSession(data.session);
          providerRef.current = data.session.provider;
          const taggedMessages = data.messages.map((m) => ({
            ...m,
            _source: "jsonl" as const,
          }));
          updatePersistedTimestampWatermark(taggedMessages);
          const merged = mergeJSONLMessages(warmMessages, taggedMessages, {
            skipDagOrdering: !getProvider(data.session.provider).capabilities
              .supportsDag,
          });
          const loadedMessages = usesApproxMessageDedup(data.session.provider)
            ? reconcileLinearMessages(
                merged.messages,
                approxDedupOptions(data.session.provider),
              )
            : merged.messages;
          setMessages(loadedMessages);
          setPagination(data.pagination ?? warm?.pagination);
          markReloadPerfPhase("session_initial_messages_state_queued", {
            messages: taggedMessages.length,
            totalMessages: loadedMessages.length,
            provider: data.session.provider,
          });
          const lastJsonlId = findLastJsonlMessageId(loadedMessages);
          if (lastJsonlId) {
            lastMessageIdRef.current = lastJsonlId;
          }
          initialLoadCompleteRef.current = true;
          warmHydrationRef.current = null;
          flushBuffer();
          setLoading(false);
          markReloadPerfPhase("session_initial_load_complete", {
            messages: taggedMessages.length,
          });
          cacheAdapter.write(
            projectId,
            sessionId,
            {
              messages: loadedMessages,
              session: data.session,
              pagination: data.pagination ?? warm?.pagination,
              agentContent: agentContentRef.current,
              toolUseToAgentEntries: Array.from(
                toolUseToAgentRef.current.entries(),
              ),
              lastMessageId: lastMessageIdRef.current,
              maxPersistedTimestampMs: maxPersistedTimestampMsRef.current,
            },
            tailTurns,
            tailFrom,
          );
          onLoadComplete?.({
            session: data.session,
            status: data.ownership,
            pendingInputRequest: data.pendingInputRequest,
            slashCommands: data.slashCommands,
          });
        } else {
          applyColdLoad(data);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        markReloadPerfPhase("session_initial_load_error", {
          message: err instanceof Error ? err.message : String(err),
        });
        setLoading(false);
        onLoadError?.(err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    cacheAdapter,
    onLoadComplete,
    onLoadError,
    flushBuffer,
    updatePersistedTimestampWatermark,
  ]);

  // Handle streaming content updates (from useStreamingContent)
  const handleStreamingUpdate = useCallback(
    (streamingMessage: Message, agentId?: string) => {
      const messageId = getMessageId(streamingMessage);
      if (!messageId) return;

      if (agentId) {
        // Route to agentContent
        setAgentContent((prev) => {
          const existing = prev[agentId] ?? {
            messages: [],
            status: "running" as const,
          };
          const existingIdx = findMessageIndexById(
            existing.messages,
            messageId,
          );

          if (existingIdx >= 0) {
            const updated = [...existing.messages];
            updated[existingIdx] = streamingMessage;
            return { ...prev, [agentId]: { ...existing, messages: updated } };
          }
          return {
            ...prev,
            [agentId]: {
              ...existing,
              messages: [...existing.messages, streamingMessage],
            },
          };
        });
        return;
      }

      // Route to main messages
      setMessages((prev) => {
        const existingIdx = findMessageIndexById(prev, messageId);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = streamingMessage;
          return updated;
        }
        return [...prev, streamingMessage];
      });
    },
    [],
  );

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({ type: "message", msg: incoming });
        return;
      }
      processStreamMessage(incoming);
    },
    [processStreamMessage],
  );

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      if (!initialLoadCompleteRef.current) {
        streamBufferRef.current.push({
          type: "subagent",
          msg: incoming,
          agentId,
        });
        return;
      }
      processStreamSubagentMessage(incoming, agentId);
    },
    [processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
    (toolUseId: string, agentId: string) => {
      setToolUseToAgent((prev) => {
        if (prev.has(toolUseId)) return prev;
        const next = new Map(prev);
        next.set(toolUseId, agentId);
        return next;
      });
    },
    [],
  );

  const fetchNewMessagesInFlightRef = useRef<Promise<void> | null>(null);

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(() => {
    if (fetchNewMessagesInFlightRef.current) {
      return fetchNewMessagesInFlightRef.current;
    }

    const request = (async () => {
      try {
        const data = await api.getSession(
          projectId,
          sessionId,
          lastMessageIdRef.current,
        );
        if (data.messages.length > 0) {
          updatePersistedTimestampWatermark(data.messages);
          setMessages((prev) => {
            const result = mergeJSONLMessages(prev, data.messages, {
              skipDagOrdering: !getProvider(data.session.provider).capabilities
                .supportsDag,
            });
            return usesApproxMessageDedup(data.session.provider)
              ? reconcileLinearMessages(
                  result.messages,
                  approxDedupOptions(data.session.provider),
                )
              : result.messages;
          });
        }
        // Update session metadata (including title, model, contextUsage) which may have changed
        // For new sessions, prev may be null if JSONL didn't exist on initial load
        setSession((prev) =>
          prev ? { ...prev, ...data.session } : data.session,
        );
      } catch {
        // Silent fail for incremental updates
      }
    })();

    fetchNewMessagesInFlightRef.current = request;
    void request.finally(() => {
      if (fetchNewMessagesInFlightRef.current === request) {
        fetchNewMessagesInFlightRef.current = null;
      }
    });

    return request;
  }, [projectId, sessionId, updatePersistedTimestampWatermark]);

  // Load older messages (previous chunk before the current truncation point)
  const loadOlderMessages = useCallback(async () => {
    if (!pagination?.hasOlderMessages || !pagination.truncatedBeforeMessageId) {
      return;
    }
    setLoadingOlder(true);
    try {
      const data = await api.getSession(projectId, sessionId, undefined, {
        tailCompactions: 2,
        beforeMessageId: pagination.truncatedBeforeMessageId,
      });
      setMessages((prev) => {
        const taggedOlder = data.messages.map((m) => ({
          ...m,
          _source: "jsonl" as const,
        }));
        updatePersistedTimestampWatermark(taggedOlder);
        const combined = [...taggedOlder, ...prev];
        return usesApproxMessageDedup(data.session.provider)
          ? reconcileLinearMessages(
              combined,
              approxDedupOptions(data.session.provider),
            )
          : combined;
      });
      setPagination(data.pagination);
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [projectId, sessionId, pagination, updatePersistedTimestampWatermark]);

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      const metadataSession = {
        ...data.session,
        ownership: data.ownership,
      };
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      setSession((prev) =>
        prev ? { ...prev, ...metadataSession } : metadataSession,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [projectId, sessionId]);

  return {
    messages,
    agentContent,
    toolUseToAgent,
    loading,
    session,
    setSession,
    handleStreamingUpdate,
    handleStreamMessageEvent,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    setAgentContent,
    setToolUseToAgent,
    setMessages,
    fetchNewMessages,
    fetchSessionMetadata,
    pagination,
    loadingOlder,
    loadOlderMessages,
  };
}
