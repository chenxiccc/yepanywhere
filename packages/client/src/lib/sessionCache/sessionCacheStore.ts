/**
 * Async read/write surface the hook uses for the persistent session cache.
 * hook 使用的持久化会话缓存异步读写接口。
 *
 * Mirrors the old in-memory readSessionLoadCache / writeSessionLoadCache
 * signatures so the hook refactor stays minimal, but is async and backed by
 * IndexedDB. The `enabled` gate is the server-side sessionLoadCacheEnabled flag
 * threaded in from SessionPage; when false, all ops are no-ops (cold path).
 * 镜像旧内存版 readSessionLoadCache / writeSessionLoadCache 的签名，使 hook
 * 重构最小化，但改为异步、由 IndexedDB 支撑。`enabled` 开关是服务端
 * sessionLoadCacheEnabled 标志，从 SessionPage 透传而来；为 false 时所有操作
 * 皆为 no-op（冷路径）。
 */

import type { PaginationInfo } from "../../api/client";
import type {
  AgentContentMap,
  Message,
  SessionMetadata,
} from "../../types";
import {
  getSessionCacheEntry,
  putSessionCacheEntry,
  trimSessionCache,
} from "./sessionCacheDb";
import {
  SESSION_CACHE_SCHEMA_VERSION,
  estimateEntrySizeBytes,
  type SessionCacheEntry,
} from "./sessionCacheEntry";

// Re-export the entry type so the hook imports everything from one module.
// re-export entry 类型，使 hook 从单一模块导入。
export type { SessionCacheEntry };

/** Payload the hook hands to writeSessionCache (mirrors SessionLoadCacheEntry). */
// hook 传给 writeSessionCache 的载荷（镜像 SessionLoadCacheEntry）。
export interface SessionCachePayload {
  messages: Message[];
  session: SessionMetadata;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
}

function cloneForCache<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getSessionCacheVariantKey(options: {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
}): string {
  const variant = [
    options.tailTurns !== undefined ? `tailTurns=${options.tailTurns}` : "",
    options.tailFrom ? `tailFrom=${options.tailFrom}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const base = `${options.projectId}:${options.sessionId}`;
  return variant ? `${base}?${variant}` : base;
}

/** Read a cached entry. Returns null when disabled, SSR, or cache miss. */
// 读取缓存条目。禁用、SSR 或未命中时返回 null。
export async function readSessionCache(
  projectId: string,
  sessionId: string,
  tailTurns?: number,
  tailFrom?: string,
  enabled = false,
): Promise<SessionCacheEntry | null> {
  if (!enabled) return null;
  if (typeof window === "undefined") return null;
  const cacheKey = getSessionCacheVariantKey({
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
  });
  try {
    return await getSessionCacheEntry(cacheKey);
  } catch {
    return null;
  }
}

/**
 * Write a cached entry (fire-and-forget at the call site). Clones the payload,
 * computes size, and triggers LRU trim. Never throws into the load path.
 * 写入缓存条目（调用处 fire-and-forget）。克隆载荷、计算体积、触发 LRU 淘汰。
 * 绝不向加载路径抛错。
 */
export async function writeSessionCache(
  projectId: string,
  sessionId: string,
  payload: SessionCachePayload,
  tailTurns?: number,
  tailFrom?: string,
  enabled = false,
): Promise<void> {
  if (!enabled) return;
  if (typeof window === "undefined") return;
  const cacheKey = getSessionCacheVariantKey({
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
  });
  const cloned = cloneForCache(payload);
  const entry: SessionCacheEntry = {
    cacheKey,
    projectId,
    sessionId,
    messages: cloned.messages,
    session: cloned.session,
    pagination: cloned.pagination,
    agentContent: cloned.agentContent,
    toolUseToAgentEntries: cloned.toolUseToAgentEntries,
    lastMessageId: cloned.lastMessageId,
    maxPersistedTimestampMs: cloned.maxPersistedTimestampMs,
    cachedTotalMessageCount: cloned.pagination?.totalMessageCount,
    cachedUpdatedAt: cloned.session.updatedAt,
    lastUsedMs: Date.now(),
    sizeBytes: estimateEntrySizeBytes(cloned),
    schemaVersion: SESSION_CACHE_SCHEMA_VERSION,
  };
  try {
    await putSessionCacheEntry(entry);
    await trimSessionCache();
  } catch {
    // Swallow: caching is best-effort; never break the load path.
    // 吞掉：缓存是尽力而为；绝不断开加载路径。
  }
}

/**
 * Adapter the hook consumes, so it does not import the store directly.
 * hook 消费的适配器，使其不直接 import store。
 *
 * The adapter captures the `enabled` flag at construction; when disabled,
 * read returns null and write is a no-op (cold path). This lets the hook
 * call adapter.read/write without branching on enabled itself.
 * 适配器在构造时捕获 `enabled` 开关；禁用时 read 返回 null、write 为 no-op
 * （冷路径）。使 hook 调用 adapter.read/write 时无需自行判断 enabled。
 */
export interface SessionCacheAdapter {
  read(
    projectId: string,
    sessionId: string,
    tailTurns?: number,
    tailFrom?: string,
  ): Promise<SessionCacheEntry | null>;
  write(
    projectId: string,
    sessionId: string,
    payload: SessionCachePayload,
    tailTurns?: number,
    tailFrom?: string,
  ): Promise<void>;
}

/**
 * No-op adapter used when the cache is disabled (or before settings resolve).
 * 缓存禁用（或设置加载前）时使用的 no-op 适配器。
 */
const NOOP_ADAPTER: SessionCacheAdapter = {
  read: async () => null,
  write: async () => {},
};

/**
 * Build an adapter bound to the given enabled flag. Returns a no-op adapter
 * when disabled, so the hook's call sites stay branch-free.
 * 构造绑定到指定 enabled 开关的适配器。禁用时返回 no-op 适配器，
 * 使 hook 调用点无需分支判断。
 */
export function createSessionCacheAdapter(
  enabled: boolean,
): SessionCacheAdapter {
  if (!enabled) return NOOP_ADAPTER;
  return {
    read: (projectId, sessionId, tailTurns, tailFrom) =>
      readSessionCache(projectId, sessionId, tailTurns, tailFrom, true),
    write: (projectId, sessionId, payload, tailTurns, tailFrom) =>
      writeSessionCache(
        projectId,
        sessionId,
        payload,
        tailTurns,
        tailFrom,
        true,
      ),
  };
}
