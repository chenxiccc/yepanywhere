import type { StagedAttachmentRef } from "@yep-anywhere/shared";
import { toPersistedStagedAttachmentRef as toPersistedComposerStagedAttachmentRef } from "./sessionComposerAttachments";

export interface PendingLocalFile {
  kind: "local";
  id: string;
  file: File;
  previewUrl?: string;
}

export interface PendingUploadingFile {
  kind: "uploading";
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  previewUrl?: string;
}

export type PendingStagedFile = StagedAttachmentRef & {
  kind: "staged";
  previewUrl?: string;
};

export type PendingFile =
  | PendingLocalFile
  | PendingUploadingFile
  | PendingStagedFile;

export function isPendingLocalFile(
  file: PendingFile,
): file is PendingLocalFile {
  return file.kind === "local";
}

export function isPendingStagedFile(
  file: PendingFile,
): file is PendingStagedFile {
  return file.kind === "staged";
}

export function getPendingFileName(file: PendingFile): string {
  return isPendingLocalFile(file) ? file.file.name : file.originalName;
}

export function getPendingFileSize(file: PendingFile): number {
  return isPendingLocalFile(file) ? file.file.size : file.size;
}

export function toPersistedStagedAttachmentRef(
  attachment: PendingStagedFile,
): StagedAttachmentRef {
  return toPersistedComposerStagedAttachmentRef(attachment);
}

export function revokePendingFilePreviewUrls(
  files: readonly PendingFile[],
): void {
  for (const file of files) {
    if (file.previewUrl) {
      URL.revokeObjectURL(file.previewUrl);
    }
  }
}
