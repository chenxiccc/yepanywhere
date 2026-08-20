import "fake-indexeddb/auto";

import type { UploadedFile } from "@yep-anywhere/shared";
import { planThumbnail } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteEntry,
  getEntry,
  openDatabase,
  putEntryWithKey,
} from "../diagnostics/idb";
import {
  loadCachedAttachmentPreview,
  storeUploadedAttachmentPreview,
} from "../attachmentPreviewCache";
import { resizeImageFile } from "../imageAttachmentResize";

const DB_NAME = "yep-anywhere-attachment-previews";
const STORE_NAME = "images";

function openPreviewDatabase(): Promise<IDBDatabase> {
  return openDatabase(DB_NAME, 2, (db: IDBDatabase, tx: IDBTransaction) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME);
      store.createIndex("byLastAccessedAt", "lastAccessedAt");
      return;
    }

    const store = tx.objectStore(STORE_NAME);
    if (!store.indexNames.contains("byLastAccessedAt")) {
      store.createIndex("byLastAccessedAt", "lastAccessedAt");
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image attachment resizing", () => {
  it("renames resized images to match the encoded output", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 3000,
        close,
      })),
    );

    const originalCreateElement = document.createElement.bind(document);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(["thumb"], { type: "image/png" }));
      }),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        if (tagName === "canvas") {
          return canvas;
        }
        return originalCreateElement(tagName);
      },
    );

    const file = new File(["payload"], "disconnect-pull-plate-condition.jpeg", {
      type: "image/jpeg",
    });

    const resized = await resizeImageFile(file, 2048);

    expect(resized).not.toBe(file);
    expect(resized.name).toBe("disconnect-pull-plate-condition-sd.png");
    expect(resized.type).toBe("image/png");
  });
});

describe("attachment thumbnail generation", () => {
  it("center-crops wide images to a 2:1 thumbnail box", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 1000,
        close,
      })),
    );

    const drawImage = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(["thumb"], { type: "image/png" }));
      }),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        if (tagName === "canvas") {
          return canvas;
        }
        return originalCreateElement(tagName);
      },
    );

    const sourceFile = new File(["wide"], "wide.png", { type: "image/png" });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-wide",
      originalName: "wide.png",
      name: "attachment-id-wide_wide.png",
      path: "/project/.attachments/session/attachment-id-wide_wide.png",
      size: sourceFile.size,
      mimeType: "image/png",
    };

    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const planned = planThumbnail(4000, 1000);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({
        close,
      }),
      1000,
      0,
      2000,
      1000,
      0,
      0,
      planned.width,
      planned.height,
    );
  });
});

describe("attachment preview cache", () => {
  it("stores previews under attachment ids", async () => {
    const sourceFile = new File(["preview"], "pump-bottom.jpeg", {
      type: "image/jpeg",
    });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-1",
      originalName: "pump-bottom.jpeg",
      name: "attachment-id-1_pump-bottom.jpeg",
      path: "/project/.attachments/session/attachment-id-1_pump-bottom.jpeg",
      size: sourceFile.size,
      mimeType: "image/jpeg",
    };

    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const db = await openPreviewDatabase();
    expect(await getEntry(db, STORE_NAME, uploadedFile.id)).toMatchObject({
      attachmentId: uploadedFile.id,
      path: uploadedFile.path,
    });
    expect(await getEntry(db, STORE_NAME, uploadedFile.path)).toMatchObject({
      aliasFor: uploadedFile.id,
    });
    db.close();

    const loadedByPath = await loadCachedAttachmentPreview(
      uploadedFile.path,
      uploadedFile.path,
    );
    expect(loadedByPath?.attachmentId).toBe(uploadedFile.id);
    expect(loadedByPath?.path).toBe(uploadedFile.path);
  });

  it("migrates legacy path-keyed previews onto attachment ids", async () => {
    const legacyPath = "/project/.attachments/session/legacy-path.jpg";
    const attachmentId = "attachment-id-2";
    const db = await openPreviewDatabase();
    await putEntryWithKey(db, STORE_NAME, legacyPath, {
      attachmentId: "legacy-path-key",
      path: legacyPath,
      originalName: "legacy-path.jpg",
      mimeType: "image/png",
      size: 4,
      thumbnailVariant: "thumb:v1:96:image/png",
      thumbnailWidth: 1,
      thumbnailHeight: 1,
      thumbnailBlob: new Blob(["thumb"], { type: "image/png" }),
      fullBlob: new Blob(["full"], { type: "image/png" }),
      totalBytes: 8,
      createdAt: Date.now() - 1000,
      lastAccessedAt: Date.now() - 1000,
    });

    const loaded = await loadCachedAttachmentPreview(attachmentId, legacyPath);

    expect(loaded?.attachmentId).toBe(attachmentId);
    expect(await getEntry(db, STORE_NAME, attachmentId)).toMatchObject({
      attachmentId,
      path: legacyPath,
    });
    expect(await getEntry(db, STORE_NAME, legacyPath)).toMatchObject({
      aliasFor: attachmentId,
    });
    db.close();
  });

  it("serves a stored preview from the database rather than memory", async () => {
    // Only an upload in flight may be held in memory; once stored, the entry
    // lives under the database eviction budget and nowhere else, reachable by
    // its persisted path through a pointer rather than a second copy.
    const sourceFile = new File(["preview"], "held.jpeg", {
      type: "image/jpeg",
    });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-3",
      originalName: "held.jpeg",
      name: "attachment-id-3_held.jpeg",
      path: "/project/.attachments/session/attachment-id-3_held.jpeg",
      size: sourceFile.size,
      mimeType: "image/jpeg",
    };

    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const db = await openPreviewDatabase();
    await deleteEntry(db, STORE_NAME, uploadedFile.id);
    db.close();

    expect(
      await loadCachedAttachmentPreview(uploadedFile.id, uploadedFile.path),
    ).toBeNull();
  });

  it("evicts preview and alias pairs without deleting live aliases", async () => {
    const db = await openPreviewDatabase();
    const recentId = "attachment-id-recent";
    const recentPath = "/project/.attachments/session/recent.jpg";
    const oldId = "attachment-id-old";
    const oldPath = "/project/.attachments/session/old.jpg";
    const preview = (
      attachmentId: string,
      path: string,
      lastAccessedAt: number,
    ) => ({
      attachmentId,
      path,
      originalName: `${attachmentId}.jpg`,
      mimeType: "image/jpeg",
      size: 1,
      thumbnailVariant: "current",
      thumbnailWidth: 1,
      thumbnailHeight: 1,
      fullBlob: new Blob(["x"], { type: "image/jpeg" }),
      totalBytes: 70 * 1024 * 1024,
      createdAt: 1,
      lastAccessedAt,
    });
    await putEntryWithKey(
      db,
      STORE_NAME,
      recentId,
      preview(recentId, recentPath, 300),
    );
    await putEntryWithKey(db, STORE_NAME, recentPath, {
      aliasFor: recentId,
      totalBytes: 0,
      lastAccessedAt: 100,
    });
    await putEntryWithKey(db, STORE_NAME, oldId, preview(oldId, oldPath, 200));
    await putEntryWithKey(db, STORE_NAME, oldPath, {
      aliasFor: oldId,
      totalBytes: 0,
      lastAccessedAt: 150,
    });
    db.close();

    const sourceFile = new File(["new"], "new.jpg", { type: "image/jpeg" });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-new",
      originalName: "new.jpg",
      name: "attachment-id-new_new.jpg",
      path: "/project/.attachments/session/new.jpg",
      size: sourceFile.size,
      mimeType: "image/jpeg",
    };
    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const inspected = await openPreviewDatabase();
    expect(await getEntry(inspected, STORE_NAME, recentId)).toBeDefined();
    expect(await getEntry(inspected, STORE_NAME, recentPath)).toMatchObject({
      aliasFor: recentId,
    });
    expect(await getEntry(inspected, STORE_NAME, oldId)).toBeNull();
    expect(await getEntry(inspected, STORE_NAME, oldPath)).toBeNull();
    inspected.close();
  });
});
