import { describe, expect, it, vi } from "vitest";
import {
  type PendingFile,
  getPendingFileImageDimensions,
  getPendingFileMimeType,
  getPendingFileName,
  getPendingFileSize,
  isPendingLocalFile,
  isPendingStagedFile,
  revokePendingFilePreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../newSessionAttachments";

describe("new session attachments", () => {
  it("reads display metadata from local and staged pending files", () => {
    const local = {
      kind: "local",
      id: "local-1",
      file: { name: "local.png", size: 42, type: "image/png" } as File,
    } satisfies PendingFile;
    const staged = {
      kind: "staged",
      id: "staged-1",
      batchId: "batch-1",
      originalName: "staged.txt",
      name: "staged.txt",
      size: 84,
      mimeType: "text/plain",
      createdAt: "2026-07-06T10:00:00.000Z",
      updatedAt: "2026-07-06T10:00:01.000Z",
    } satisfies PendingFile;

    expect(isPendingLocalFile(local)).toBe(true);
    expect(isPendingStagedFile(staged)).toBe(true);
    expect(getPendingFileName(local)).toBe("local.png");
    expect(getPendingFileSize(local)).toBe(42);
    expect(getPendingFileName(staged)).toBe("staged.txt");
    expect(getPendingFileSize(staged)).toBe(84);
    expect(getPendingFileMimeType(local)).toBe("image/png");
    expect(getPendingFileMimeType(staged)).toBe("text/plain");
    expect(getPendingFileImageDimensions(staged)).toBeUndefined();
  });

  it("exposes staged image dimensions for hover placement", () => {
    const staged = {
      kind: "staged",
      id: "staged-image",
      batchId: "batch-1",
      originalName: "photo.png",
      name: "photo.png",
      size: 12,
      mimeType: "image/png",
      width: 759,
      height: 668,
      createdAt: "2026-07-06T10:00:00.000Z",
      updatedAt: "2026-07-06T10:00:01.000Z",
    } satisfies PendingFile;

    expect(getPendingFileImageDimensions(staged)).toEqual({
      width: 759,
      height: 668,
    });
  });

  it("strips pending-only staged attachment fields before persistence", () => {
    expect(
      toPersistedStagedAttachmentRef({
        kind: "staged",
        id: "att-1",
        batchId: "batch-1",
        originalName: "photo.png",
        name: "photo.png",
        size: 123,
        mimeType: "image/png",
        width: 640,
        height: 480,
        createdAt: "2026-07-06T10:00:00.000Z",
        updatedAt: "2026-07-06T10:00:01.000Z",
        previewUrl: "blob:preview",
      }),
    ).toEqual({
      id: "att-1",
      batchId: "batch-1",
      originalName: "photo.png",
      name: "photo.png",
      size: 123,
      mimeType: "image/png",
      width: 640,
      height: 480,
      createdAt: "2026-07-06T10:00:00.000Z",
      updatedAt: "2026-07-06T10:00:01.000Z",
    });
  });

  it("revokes only pending previews that have object URLs", () => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const files: PendingFile[] = [
      {
        kind: "uploading",
        id: "uploading-1",
        originalName: "uploading.png",
        size: 1,
        mimeType: "image/png",
        previewUrl: "blob:uploading",
      },
      {
        kind: "local",
        id: "local-1",
        file: { name: "local.txt", size: 2 } as File,
      },
    ];

    try {
      revokePendingFilePreviewUrls(files);

      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:uploading");
    } finally {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });
});
