export const INCOMING_SHARE_QUERY_PARAM = "__ya_share";

const INCOMING_SHARE_DB_NAME = "ya-incoming-shares";
const INCOMING_SHARE_STORE_NAME = "shares";
const INCOMING_SHARE_DB_VERSION = 1;

interface StoredIncomingShareFile {
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
}

interface StoredIncomingShare {
  id: string;
  createdAt: number;
  files: StoredIncomingShareFile[];
}

function openIncomingShareDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Browser storage is unavailable"));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      INCOMING_SHARE_DB_NAME,
      INCOMING_SHARE_DB_VERSION,
    );
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INCOMING_SHARE_STORE_NAME)) {
        db.createObjectStore(INCOMING_SHARE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function isStoredIncomingShare(value: unknown): value is StoredIncomingShare {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredIncomingShare>;
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "number" &&
    Array.isArray(record.files) &&
    record.files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        file.blob instanceof Blob &&
        typeof file.name === "string" &&
        typeof file.type === "string" &&
        typeof file.lastModified === "number",
    )
  );
}

/**
 * Atomically remove one service-worker share and return browser File objects
 * accepted by the existing composer attachment pipeline.
 */
export async function claimIncomingShare(id: string): Promise<File[]> {
  const db = await openIncomingShareDb();

  return new Promise<File[]>((resolve, reject) => {
    const transaction = db.transaction(INCOMING_SHARE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(INCOMING_SHARE_STORE_NAME);
    let stored: unknown;

    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      stored = request.result;
      store.delete(id);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => {
      db.close();
      if (!isStoredIncomingShare(stored)) {
        resolve([]);
        return;
      }
      resolve(
        stored.files.map(
          (file) =>
            new File([file.blob], file.name, {
              type: file.type,
              lastModified: file.lastModified,
            }),
        ),
      );
    };
  }).finally(() => db.close());
}
