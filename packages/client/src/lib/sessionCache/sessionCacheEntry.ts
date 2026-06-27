/**
 * IndexedDB-backed cache of conversation message tails, for fast remote reopen.
 * 基于 IndexedDB 的对话消息尾部缓存，用于远程重开加速。
 *
 * Replaces the dev-only in-memory SessionLoadCache. Persisted per
 * (projectId, sessionId, tailVariant). On reopen, the hook hydrates from
 * this cache instantly, then issues an incremental afterMessageId refresh
 * whose response also validates cache staleness (totalMessageCount mismatch).
 * 替代 dev-only 的内存版 SessionLoadCache。按 (projectId, sessionId, tailVariant)
 * 持久化。重开时 hook 先从此缓存秒开 hydrate，再发起 afterMessageId 增量刷新，
 * 该响应同时用于校验缓存是否过期（totalMessageCount 不一致即丢弃重拉）。
 */

import type { PaginationInfo } from "../../api/client";
import type {
  AgentContentMap,
  Message,
  SessionMetadata,
} from "../../types";

/** Mirrors the hook's SessionLoadCacheEntry, plus cache-control metadata. */
// 镜像 hook 的 SessionLoadCacheEntry，并附加缓存控制元数据。
export interface SessionCacheEntry {
  /** cacheKey = getSessionLoadVariantKey(...) */
  cacheKey: string;
  projectId: string;
  sessionId: string;
  // Payload — mirrors SessionLoadCacheEntry.
  // 载荷 —— 镜像 SessionLoadCacheEntry。
  messages: Message[];
  session: SessionMetadata;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
  /** Snapshot of pagination.totalMessageCount at write time; mismatch on
   * reopen => cache stale (compacted elsewhere), trigger full tail reload. */
  // 写入时 pagination.totalMessageCount 的快照；重开时不一致 => 缓存过期
  // （别处 compact 过），触发全量尾部重拉。
  cachedTotalMessageCount?: number;
  /** Logging/secondary hint only — NOT a discard signal (updatedAt advances
   * on heartbeats/appends where the incremental delta still merges fine). */
  // 仅作日志/次要提示 —— 不作为丢弃信号（心跳/追加会让 updatedAt 前移，
  // 但增量 delta 仍可正常合并）。
  cachedUpdatedAt?: string;
  /** Monotonic ms timestamp of last write/read — used for LRU eviction. */
  // 最近写入/读取的单调毫秒时间戳 —— 用于 LRU 淘汰。
  lastUsedMs: number;
  /** JSON UTF-8 byte length of the payload, recomputed on every write. */
  // 载荷的 JSON UTF-8 字节长度，每次写入时重算。
  sizeBytes: number;
  /** Bump when entry shape changes; mismatched reads are discarded (lazy migration). */
  // entry 结构变更时递增；读取时不匹配则丢弃（懒迁移）。
  schemaVersion: number;
}

export const SESSION_CACHE_SCHEMA_VERSION = 1;

/** Estimate the JSON UTF-8 byte size of the payload portion of an entry. */
// 估算 entry 载荷部分的 JSON UTF-8 字节大小。
export function estimateEntrySizeBytes(payload: {
  messages: Message[];
  session: SessionMetadata;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  toolUseToAgentEntries: Array<[string, string]>;
}): number {
  // Blob.size is UTF-8 byte length; structuredClone-safe like cloneForCache.
  // Blob.size 即 UTF-8 字节长度；与 cloneForCache 一样 structuredClone 安全。
  try {
    return new Blob([JSON.stringify(payload)]).size;
  } catch {
    // Fallback: approximate via string length (UTF-16 units, close enough for caps).
    // 回退：用字符串长度近似（UTF-16 单元，用于上限判断足够接近）。
    return JSON.stringify(payload).length;
  }
}
