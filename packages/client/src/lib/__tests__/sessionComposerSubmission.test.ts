import type { StagedAttachmentRef, UploadedFile } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SourceTransport } from "../transport";
import {
  appendComposerTransferDraft,
  appendSlashCommandDraft,
  collectComposerAttachmentsForSubmission,
  createComposerDraftAttachmentState,
  getComposerTransferReplacement,
  materializeComposerAttachmentsForSubmission,
  splitComposerAttachmentsForSubmission,
  uploadComposerAttachmentFile,
} from "../sessionComposerSubmission";
import type { ComposerAttachment } from "../sessionComposerAttachments";

const stagedRef: StagedAttachmentRef = {
  id: "staged-a",
  batchId: "batch-a",
  originalName: "draft.png",
  name: "uuid_draft.png",
  size: 123,
  mimeType: "image/png",
  width: 320,
  height: 240,
  createdAt: "2026-07-06T10:00:00.000Z",
  updatedAt: "2026-07-06T10:00:01.000Z",
};

const uploadedFile: UploadedFile = {
  id: "uploaded-a",
  originalName: "notes.txt",
  name: "uuid_notes.txt",
  path: "/uploads/uuid_notes.txt",
  size: 12,
  mimeType: "text/plain",
};

describe("session composer submission helpers", () => {
  it("builds transfer and slash-command draft text without changing spacing rules", () => {
    expect(
      getComposerTransferReplacement(" existing  ", "  addition "),
    ).toEqual({
      start: 9,
      end: 11,
      replacement: "\n\naddition",
      nextDraft: " existing\n\naddition",
    });

    expect(appendComposerTransferDraft("", "  addition ")).toBe("addition");
    expect(appendSlashCommandDraft("/mo", "model")).toBe("/model ");
    expect(appendSlashCommandDraft("hello", "/fast")).toBe("hello /fast ");
  });

  it("creates draft attachment state and rejects split staging batches", () => {
    const withPreview = { ...stagedRef, previewUrl: "blob:draft" };

    expect(
      createComposerDraftAttachmentState([uploadedFile, withPreview], "now"),
    ).toEqual({
      batchId: "batch-a",
      refs: [stagedRef],
      updatedAt: "now",
    });
    expect(
      createComposerDraftAttachmentState([uploadedFile], "now"),
    ).toBeNull();
    expect(() =>
      splitComposerAttachmentsForSubmission([
        stagedRef,
        { ...stagedRef, id: "staged-b", batchId: "batch-b" },
      ]),
    ).toThrow("Draft attachments are split across staging batches");
  });

  it("collects pending uploads and clears composer attachments around submission", async () => {
    const setComposerAttachments = vi.fn();
    const updatePendingMessage = vi.fn();
    const pendingAttachment: ComposerAttachment = {
      ...uploadedFile,
      id: "pending-upload",
    };

    await expect(
      collectComposerAttachmentsForSubmission({
        currentAttachments: [uploadedFile],
        pendingUploads: [Promise.resolve(pendingAttachment)],
        setComposerAttachments,
        pendingMessageId: "temp-a",
        updatePendingMessage,
        uploadingStatus: "Uploading",
      }),
    ).resolves.toEqual([uploadedFile, pendingAttachment]);

    expect(updatePendingMessage).toHaveBeenNthCalledWith(1, "temp-a", {
      status: "Uploading",
    });
    expect(setComposerAttachments).toHaveBeenNthCalledWith(1, [], {
      persistDraft: false,
    });
    expect(setComposerAttachments).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { persistDraft: false },
    );
    expect(updatePendingMessage).toHaveBeenLastCalledWith("temp-a", {
      status: undefined,
    });
  });

  it("materializes staged refs after preserving already uploaded files", async () => {
    const materializedFile: UploadedFile = {
      ...uploadedFile,
      id: "materialized-a",
    };
    const sourceTransport = {
      fetch: vi.fn().mockResolvedValue({ files: [materializedFile] }),
    } as unknown as Pick<SourceTransport, "fetch">;

    await expect(
      materializeComposerAttachmentsForSubmission({
        attachments: [uploadedFile, stagedRef],
        sourceTransport,
        projectId: "project-a",
        sessionId: "session/a",
      }),
    ).resolves.toEqual([uploadedFile, materializedFile]);

    expect(sourceTransport.fetch).toHaveBeenCalledWith(
      "/projects/project-a/sessions/session%2Fa/attachments/staging/materialize",
      {
        method: "POST",
        body: JSON.stringify({ batchId: "batch-a", refs: [stagedRef] }),
      },
    );
  });

  it("uploads direct and staged composer files with progress callbacks", async () => {
    const directFile = new File(["hello"], "notes.txt", {
      type: "text/plain",
    });
    const imageFile = new File(["image"], "image.png", { type: "image/png" });
    const upload = vi.fn(async (_projectId, _sessionId, file, options) => {
      options?.onProgress?.(file.size);
      return { ...uploadedFile, size: file.size };
    });
    const uploadStagedAttachment = vi.fn(async (file, options) => {
      options?.onProgress?.(file.size);
      return { ...stagedRef, size: file.size };
    });
    const sourceTransport = {
      upload,
      uploadStagedAttachment,
    } as unknown as Pick<SourceTransport, "upload" | "uploadStagedAttachment">;
    const progress = vi.fn();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:image-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    try {
      await expect(
        uploadComposerAttachmentFile({
          file: directFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          maxLongEdgePx: 1024,
          onProgress: progress,
        }),
      ).resolves.toMatchObject({ id: "uploaded-a", size: directFile.size });

      await expect(
        uploadComposerAttachmentFile({
          file: imageFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          maxLongEdgePx: 1024,
          stagedBatchId: "batch-a",
          onProgress: progress,
        }),
      ).resolves.toMatchObject({
        id: "staged-a",
        previewUrl: "blob:image-preview",
      });

      expect(sourceTransport.upload).toHaveBeenCalledWith(
        "project-a",
        "session-a",
        directFile,
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(sourceTransport.uploadStagedAttachment).toHaveBeenCalledWith(
        imageFile,
        expect.objectContaining({
          batchId: "batch-a",
          onProgress: expect.any(Function),
        }),
      );
      expect(progress).toHaveBeenCalledWith(directFile.size, directFile);
      expect(progress).toHaveBeenCalledWith(imageFile.size, imageFile);

      uploadStagedAttachment.mockRejectedValueOnce(new Error("boom"));
      await expect(
        uploadComposerAttachmentFile({
          file: imageFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          maxLongEdgePx: 1024,
          stagedBatchId: "batch-a",
        }),
      ).rejects.toThrow("boom");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image-preview");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });
});
