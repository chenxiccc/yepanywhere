import type { UploadedFile } from "@yep-anywhere/shared";
import {
  THUMBNAIL_HEIGHT_PX,
  THUMBNAIL_MIME_TYPE,
  THUMBNAIL_MAX_ASPECT_RATIO,
  planThumbnail,
} from "@yep-anywhere/shared";
import {
  deleteEntry,
  getEntry,
  openDatabase,
  putEntryWithKey,
} from "./diagnostics/idb";

const DB_NAME = "yep-anywhere-attachment-previews";
const DB_VERSION = 2;
const STORE_NAME = "images";
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const THUMBNAIL_CACHE_VARIANT = `thumb:v3:${THUMBNAIL_HEIGHT_PX}:${THUMBNAIL_MAX_ASPECT_RATIO}:${THUMBNAIL_MIME_TYPE}`;

interface CachedAttachmentPreview {
  attachmentId: string;
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailVariant: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnailBlob?: Blob;
  fullBlob: Blob;
  totalBytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Stored under an attachment's persisted path so a chip that knows only that
 * path reaches the preview kept under its attachment id. Carries no blobs, and
 * counts as zero bytes against the cache budget.
 */
interface CachedAttachmentAlias {
  aliasFor: string;
  totalBytes: 0;
  lastAccessedAt: number;
}

type CachedAttachmentRecord = CachedAttachmentPreview | CachedAttachmentAlias;

function isAlias(
  record: CachedAttachmentRecord | null,
): record is CachedAttachmentAlias {
  return record !== null && "aliasFor" in record;
}

function aliasTo(attachmentId: string): CachedAttachmentAlias {
  return { aliasFor: attachmentId, totalBytes: 0, lastAccessedAt: Date.now() };
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** Uploads whose bytes are in hand but not yet stored. Never grows past those. */
const memoryPreviews = new Map<string, CachedAttachmentPreview>();

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function getDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase(DB_NAME, DB_VERSION, (db, tx) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME);
        store.createIndex("byLastAccessedAt", "lastAccessedAt");
      } else {
        const store = tx.objectStore(STORE_NAME);
        if (!store.indexNames.contains("byLastAccessedAt")) {
          store.createIndex("byLastAccessedAt", "lastAccessedAt");
        }
      }
    });
  }
  return dbPromise;
}

async function createThumbnailBlob(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number } | undefined> {
  if (typeof createImageBitmap !== "function") {
    return undefined;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const thumb = planThumbnail(bitmap.width, bitmap.height);

    const canvas = document.createElement("canvas");
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.drawImage(
      bitmap,
      thumb.sourceX,
      thumb.sourceY,
      thumb.sourceWidth,
      thumb.sourceHeight,
      0,
      0,
      thumb.width,
      thumb.height,
    );
    bitmap.close();

    const blob = await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob(
        (value) => resolve(value ?? undefined),
        THUMBNAIL_MIME_TYPE,
      );
    });
    if (!blob) {
      return undefined;
    }

    return { blob, width: thumb.width, height: thumb.height };
  } catch {
    return undefined;
  }
}

function needsThumbnailRefresh(entry: CachedAttachmentPreview): boolean {
  return entry.thumbnailVariant !== THUMBNAIL_CACHE_VARIANT;
}

async function calculateCacheSize(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  const entries =
    (await new Promise<CachedAttachmentPreview[]>((resolve, reject) => {
      request.onsuccess = () =>
        resolve(request.result as CachedAttachmentPreview[]);
      request.onerror = () => reject(request.error);
    })) ?? [];
  return entries.reduce((sum, entry) => sum + (entry.totalBytes ?? 0), 0);
}

async function evictOldestEntries(
  db: IDBDatabase,
  bytesToFree: number,
): Promise<void> {
  if (bytesToFree <= 0) return;

  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("byLastAccessedAt");
  let freed = 0;

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || freed >= bytesToFree) {
        resolve();
        return;
      }

      const value = cursor.value as CachedAttachmentPreview;
      freed += value.totalBytes ?? 0;
      cursor.delete();
      cursor.continue();
    };
  });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

/**
 * The preview stored at a key, following one pointer, with the key it is
 * actually stored under so later writes land there.
 */
async function readPreview(
  db: IDBDatabase,
  key: string,
): Promise<{
  key: string;
  preview: CachedAttachmentPreview;
  viaAlias: boolean;
} | null> {
  const record = await getEntry<CachedAttachmentRecord>(db, STORE_NAME, key);
  if (!record) return null;
  if (!isAlias(record)) return { key, preview: record, viaAlias: false };
  const target = await getEntry<CachedAttachmentRecord>(
    db,
    STORE_NAME,
    record.aliasFor,
  );
  return target && !isAlias(target)
    ? { key: record.aliasFor, preview: target, viaAlias: true }
    : null;
}

/** The attachment id a stored path points at, when it is a pointer. */
async function readAlias(db: IDBDatabase, key: string): Promise<string | null> {
  const record = await getEntry<CachedAttachmentRecord>(db, STORE_NAME, key);
  return isAlias(record) ? record.aliasFor : null;
}

function rememberMemoryPreview(entry: CachedAttachmentPreview): void {
  memoryPreviews.set(entry.attachmentId, entry);
  if (entry.path && entry.path !== entry.attachmentId) {
    memoryPreviews.set(entry.path, entry);
  }
}

function forgetMemoryPreview(entry: CachedAttachmentPreview): void {
  memoryPreviews.delete(entry.attachmentId);
  if (entry.path) memoryPreviews.delete(entry.path);
}

export async function storeUploadedAttachmentPreview(
  uploadedFile: UploadedFile,
  sourceFile: File,
): Promise<void> {
  if (!isImageMimeType(uploadedFile.mimeType)) {
    return;
  }

  const uploadDimensions =
    uploadedFile.width !== undefined && uploadedFile.height !== undefined
      ? planThumbnail(uploadedFile.width, uploadedFile.height)
      : undefined;
  const fullBlob = sourceFile.slice(0, sourceFile.size, sourceFile.type);
  const now = Date.now();
  const pendingPreview: CachedAttachmentPreview = {
    attachmentId: uploadedFile.id,
    path: uploadedFile.path,
    originalName: uploadedFile.originalName,
    mimeType: uploadedFile.mimeType,
    size: uploadedFile.size,
    thumbnailVariant: THUMBNAIL_CACHE_VARIANT,
    thumbnailWidth: uploadDimensions?.width ?? THUMBNAIL_HEIGHT_PX,
    thumbnailHeight: uploadDimensions?.height ?? THUMBNAIL_HEIGHT_PX,
    fullBlob,
    totalBytes: fullBlob.size,
    createdAt: now,
    lastAccessedAt: now,
  };
  // Only the upload in flight is held in memory: a chip can ask for these
  // bytes before the store finishes, and afterwards the bounded IndexedDB
  // cache serves them. Anything retained past this call would be a copy no
  // eviction reaches.
  rememberMemoryPreview(pendingPreview);
  try {
    const thumbnail = await createThumbnailBlob(sourceFile);
    const totalBytes = fullBlob.size + (thumbnail?.blob.size ?? 0);

    const db = await getDatabase();
    const cachedPreview: CachedAttachmentPreview = {
      ...pendingPreview,
      thumbnailWidth: thumbnail?.width ?? pendingPreview.thumbnailWidth,
      thumbnailHeight: thumbnail?.height ?? pendingPreview.thumbnailHeight,
      thumbnailBlob: thumbnail?.blob,
      totalBytes,
      lastAccessedAt: Date.now(),
    };
    rememberMemoryPreview(cachedPreview);
    await putEntryWithKey<CachedAttachmentPreview>(
      db,
      STORE_NAME,
      uploadedFile.id,
      cachedPreview,
    );
    if (uploadedFile.path !== uploadedFile.id) {
      await putEntryWithKey<CachedAttachmentAlias>(
        db,
        STORE_NAME,
        uploadedFile.path,
        aliasTo(uploadedFile.id),
      ).catch(() => {});
    }

    const cacheSize = await calculateCacheSize(db);
    if (cacheSize > MAX_CACHE_BYTES) {
      await evictOldestEntries(db, cacheSize - MAX_CACHE_BYTES);
    }
  } finally {
    forgetMemoryPreview(pendingPreview);
  }
}

export async function loadCachedAttachmentPreview(
  attachmentId: string,
  legacyPath?: string,
): Promise<CachedAttachmentPreview | null> {
  const memoryEntry =
    memoryPreviews.get(attachmentId) ??
    (legacyPath && legacyPath !== attachmentId
      ? memoryPreviews.get(legacyPath)
      : undefined);
  if (memoryEntry) {
    return { ...memoryEntry, lastAccessedAt: Date.now() };
  }

  const db = await getDatabase();
  const stored =
    (await readPreview(db, attachmentId)) ??
    (legacyPath && legacyPath !== attachmentId
      ? await readPreview(db, legacyPath)
      : null);
  if (!stored) return null;
  let storageKey = stored.key;
  let entry = stored.preview;
  if (!stored.viaAlias && storageKey !== attachmentId) {
    // A preview stored before previews were keyed by attachment id. Move it
    // and leave its path pointing at the new home.
    entry = { ...entry, attachmentId };
    await putEntryWithKey<CachedAttachmentPreview>(
      db,
      STORE_NAME,
      attachmentId,
      entry,
    );
    await putEntryWithKey<CachedAttachmentAlias>(
      db,
      STORE_NAME,
      storageKey,
      aliasTo(attachmentId),
    ).catch(() => {});
    storageKey = attachmentId;
  }

  if (needsThumbnailRefresh(entry)) {
    const refreshedThumbnail = await createThumbnailBlob(entry.fullBlob);
    if (refreshedThumbnail) {
      entry = {
        ...entry,
        thumbnailWidth: refreshedThumbnail.width,
        thumbnailHeight: refreshedThumbnail.height,
        thumbnailBlob: refreshedThumbnail.blob,
        thumbnailVariant: THUMBNAIL_CACHE_VARIANT,
      };
      await putEntryWithKey<CachedAttachmentPreview>(
        db,
        STORE_NAME,
        storageKey,
        entry,
      );
    }
  }

  const updated = {
    ...entry,
    lastAccessedAt: Date.now(),
  };
  await putEntryWithKey<CachedAttachmentPreview>(
    db,
    STORE_NAME,
    storageKey,
    updated,
  );
  return updated;
}

export async function deleteCachedAttachmentPreview(
  path: string,
): Promise<void> {
  const memoryEntry = memoryPreviews.get(path);
  if (memoryEntry) {
    memoryPreviews.delete(memoryEntry.attachmentId);
    if (memoryEntry.path) memoryPreviews.delete(memoryEntry.path);
  } else {
    memoryPreviews.delete(path);
  }
  const db = await getDatabase();
  // A path may hold the preview itself or a pointer to it; both go.
  const aliased = await readAlias(db, path);
  if (aliased) await deleteEntry(db, STORE_NAME, aliased);
  await deleteEntry(db, STORE_NAME, path);
}

export function isCacheableAttachmentMimeType(mimeType: string): boolean {
  return isImageMimeType(mimeType);
}
