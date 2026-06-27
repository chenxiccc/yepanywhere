/**
 * IndexedDB plumbing for the session message cache.
 * 会话消息缓存的 IndexedDB 底层操作。
 *
 * Self-contained (does not import from diagnostics/idb.ts) so the log
 * collector's IDB helper stays untouched and the two concerns don't couple.
 * 自包含（不 import diagnostics/idb.ts），使日志收集器的 IDB helper 保持不变、
 * 两个关注点互不耦合。
 */

import {
  SESSION_CACHE_SCHEMA_VERSION,
  type SessionCacheEntry,
} from "./sessionCacheEntry";

const DB_NAME = "yep-anywhere-session-cache";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const INDEX_BY_LAST_USED = "byLastUsed";

/** LRU caps. MAX_SESSIONS bounds count; MAX_STORAGE_BYTES bounds total bytes. */
// LRU 上限。MAX_SESSIONS 限制条数；MAX_STORAGE_BYTES 限制总字节。
export const MAX_SESSIONS = 20;
export const MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB
/** Skip writing a single monster entry rather than blowing the budget. */
// 单条过大时跳过写入，避免击穿预算。
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024; // 8 MB

// Low-level IDB primitives (kept local so this module is self-contained).
// 底层 IDB 原语（保持局部，使本模块自包含）。
function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openSessionCacheDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "cacheKey",
        });
        // Index for LRU eviction: oldest lastUsedMs first.
        // 用于 LRU 淘汰的索引：lastUsedMs 最旧者优先。
        store.createIndex(INDEX_BY_LAST_USED, "lastUsedMs", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** Returns null if IndexedDB is unavailable (SSR / private mode / quota). */
// IndexedDB 不可用时返回 null（SSR / 隐私模式 / 配额）。
async function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    return await openSessionCacheDb();
  } catch {
    return null;
  }
}

export async function putSessionCacheEntry(entry: SessionCacheEntry): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Reject oversized entries up front.
  // 超大条目直接拒绝写入。
  if (entry.sizeBytes > MAX_ENTRY_BYTES) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(entry);
  await wrapTransaction(tx);
}

export async function getSessionCacheEntry(
  cacheKey: string,
): Promise<SessionCacheEntry | null> {
  const db = await getDb();
  if (!db) return null;
  const tx = db.transaction(STORE_NAME, "readonly");
  const request = tx.objectStore(STORE_NAME).get(cacheKey);
  const result = (await wrapRequest(request)) as SessionCacheEntry | undefined;
  if (!result) return null;
  // Lazy migration: discard entries written by an older shape.
  // 懒迁移：丢弃旧结构写入的条目。
  if (result.schemaVersion !== SESSION_CACHE_SCHEMA_VERSION) {
    await deleteSessionCacheEntry(cacheKey);
    return null;
  }
  return result;
}

export async function deleteSessionCacheEntry(cacheKey: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).delete(cacheKey);
  await wrapTransaction(tx);
}

export async function clearAllSessionCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).clear();
  await wrapTransaction(tx);
}

/**
 * Evict oldest entries until both MAX_SESSIONS and MAX_STORAGE_BYTES are met.
 * 淘汰最旧条目，直到同时满足 MAX_SESSIONS 与 MAX_STORAGE_BYTES。
 *
 * Walks the byLastUsed index oldest-first, deleting until count and total size
 * are within bounds. Cheap and bounded by MAX_SESSIONS. Called write-driven.
 * 按 byLastUsed 索引从最旧开始遍历删除，直到条数与总字节数都在上限内。
 * 开销低、受 MAX_SESSIONS 约束。由写入驱动调用。
 */
export async function trimSessionCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index(INDEX_BY_LAST_USED);
  // Open a cursor oldest-first (next direction on an ascending index).
  // 按最旧优先打开游标（升序索引上的 next 方向）。
  const cursorRequest = index.openCursor();
  let count = 0;
  let totalBytes = 0;
  // First pass: tally.
  // 第一遍：统计。
  await new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const entry = cursor.value as SessionCacheEntry;
        count += 1;
        totalBytes += entry.sizeBytes || 0;
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
  // If within bounds, nothing to do.
  // 在上限内则无需操作。
  if (count <= MAX_SESSIONS && totalBytes <= MAX_STORAGE_BYTES) {
    return;
  }
  // Second pass: delete oldest-first until within bounds.
  // 第二遍：从最旧开始删除，直到进入上限。
  const deleteCursorRequest = index.openCursor();
  await new Promise<void>((resolve, reject) => {
    deleteCursorRequest.onsuccess = () => {
      const cursor = deleteCursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (count > MAX_SESSIONS || totalBytes > MAX_STORAGE_BYTES) {
        const entry = cursor.value as SessionCacheEntry;
        count -= 1;
        totalBytes -= entry.sizeBytes || 0;
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    deleteCursorRequest.onerror = () => reject(deleteCursorRequest.error);
  });
  await wrapTransaction(tx);
}
