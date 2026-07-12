import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countEntries,
  deleteEntries,
  getAllEntries,
  getEntry,
  openDatabase,
  putEntry,
  putEntryWithKey,
} from "../idb";

const DB_NAME = "test-idb";
const STORE_NAME = "items";

describe("idb helpers", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openDatabase(DB_NAME, 1, (database) => {
      database.createObjectStore(STORE_NAME, {
        keyPath: "id",
        autoIncrement: true,
      });
    });
  });

  afterEach(() => {
    db.close();
    // Delete the database between tests
    indexedDB.deleteDatabase(DB_NAME);
  });

  it("opens a database and creates a store", () => {
    expect(db).toBeDefined();
    expect(db.objectStoreNames.contains(STORE_NAME)).toBe(true);
  });

  it("puts and retrieves entries", async () => {
    const key = await putEntry(db, STORE_NAME, { value: "hello" });
    expect(key).toBe(1);

    const entries = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("hello");
  });

  it("retrieves entries with count limit", async () => {
    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });
    await putEntry(db, STORE_NAME, { value: "c" });

    const limited = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
      2,
    );
    expect(limited).toHaveLength(2);
    expect(limited[0]?.value).toBe("a");
    expect(limited[1]?.value).toBe("b");
  });

  it("counts entries", async () => {
    expect(await countEntries(db, STORE_NAME)).toBe(0);

    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });

    expect(await countEntries(db, STORE_NAME)).toBe(2);
  });

  it("deletes entries by key", async () => {
    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });
    await putEntry(db, STORE_NAME, { value: "c" });

    await deleteEntries(db, STORE_NAME, [1, 3]);

    const remaining = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.value).toBe("b");
  });

  it("handles empty delete gracefully", async () => {
    await deleteEntries(db, STORE_NAME, []);
    expect(await countEntries(db, STORE_NAME)).toBe(0);
  });
});

// Replicates the sw-logs DB schema (v2) used by the SW settings persistence
// (activeSessionId/notifyInApp). The settings store uses NO keyPath —
// out-of-line keys (the setting name) with putEntryWithKey/getEntry.
// 复刻 sw-logs DB schema（v2），用于 SW 设置持久化（activeSessionId/notifyInApp）。
// settings store 无 keyPath——用 out-of-line key（setting 名）配 putEntryWithKey/getEntry。
describe("sw-logs DB v2 settings store", () => {
  const SW_DB = "sw-logs";
  const SW_DB_VERSION = 2;
  const LOGS = "logs";
  const SETTINGS = "settings";

  // 与 useNotifyInApp.ts upgradeSwDb 等价
  const upgrade = (db: IDBDatabase) => {
    if (!db.objectStoreNames.contains(LOGS)) {
      db.createObjectStore(LOGS, { keyPath: "id", autoIncrement: true });
    }
    if (!db.objectStoreNames.contains(SETTINGS)) {
      db.createObjectStore(SETTINGS); // 无 keyPath
    }
  };

  afterEach(() => {
    indexedDB.deleteDatabase(SW_DB);
  });

  it("creates both logs and settings stores on fresh install (v2)", async () => {
    const db = await openDatabase(SW_DB, SW_DB_VERSION, upgrade);
    try {
      expect(db.objectStoreNames.contains(LOGS)).toBe(true);
      expect(db.objectStoreNames.contains(SETTINGS)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("puts and gets a setting by out-of-line key, and overwrites on re-put", async () => {
    const db = await openDatabase(SW_DB, SW_DB_VERSION, upgrade);
    try {
      await putEntryWithKey(db, SETTINGS, "activeSessionId", "session-A");
      expect(await getEntry<string>(db, SETTINGS, "activeSessionId")).toBe(
        "session-A",
      );

      // 同 key 覆盖
      await putEntryWithKey(db, SETTINGS, "activeSessionId", "session-B");
      expect(await getEntry<string>(db, SETTINGS, "activeSessionId")).toBe(
        "session-B",
      );

      // 另一个 key 不受影响
      await putEntryWithKey(db, SETTINGS, "notifyInApp", true);
      expect(await getEntry<boolean>(db, SETTINGS, "notifyInApp")).toBe(true);
      expect(await getEntry<string>(db, SETTINGS, "activeSessionId")).toBe(
        "session-B",
      );
    } finally {
      db.close();
    }
  });

  it("returns null for a missing setting", async () => {
    const db = await openDatabase(SW_DB, SW_DB_VERSION, upgrade);
    try {
      expect(await getEntry(db, SETTINGS, "never-set")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("upgrades from v1 (logs only) to v2 adding settings store, preserving logs data", async () => {
    // 先以 v1 打开，只建 logs store，写一条日志
    const dbV1 = await openDatabase(SW_DB, 1, (db) => {
      if (!db.objectStoreNames.contains(LOGS)) {
        db.createObjectStore(LOGS, { keyPath: "id", autoIncrement: true });
      }
    });
    const logKey = await putEntry(dbV1, LOGS, { msg: "old log" });
    dbV1.close();

    // 再以 v2 打开，触发升级：logs 已存在（跳过），新建 settings
    const dbV2 = await openDatabase(SW_DB, SW_DB_VERSION, upgrade);
    try {
      expect(dbV2.objectStoreNames.contains(LOGS)).toBe(true);
      expect(dbV2.objectStoreNames.contains(SETTINGS)).toBe(true);
      // v1 写入的日志数据仍在
      const oldLog = await getEntry<{ msg: string }>(dbV2, LOGS, logKey as number);
      expect(oldLog?.msg).toBe("old log");
      // settings store 可用
      await putEntryWithKey(dbV2, SETTINGS, "activeSessionId", "x");
      expect(await getEntry<string>(dbV2, SETTINGS, "activeSessionId")).toBe(
        "x",
      );
    } finally {
      dbV2.close();
    }
  });
});
