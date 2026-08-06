import type { ThinkingOption, UploadedFile } from "@yep-anywhere/shared";
import { materializeDraftAttachmentsForSession } from "./draftAttachmentStaging";
import type { DraftAttachmentState } from "./draftEnvelope";
import { prepareImageUpload } from "./imageAttachmentResize";
import {
  type ComposerAttachment,
  type ComposerStagedAttachment,
  type ComposerUploadedAttachment,
  isComposerStagedAttachment,
  toPersistedStagedAttachmentRef,
} from "./sessionComposerAttachments";
import type { SourceTransport, UploadOptions } from "./transport";

export interface PreparedComposerSubmission {
  outgoingText: string;
  thinking?: ThinkingOption;
  slashCommand?: "fast" | "run";
}

export interface ComposerTransferReplacement {
  start: number;
  end: number;
  replacement: string;
  nextDraft: string;
}

export function getComposerTransferReplacement(
  currentDraft: string,
  text: string,
): ComposerTransferReplacement {
  const current = currentDraft.trimEnd();
  const addition = text.trim();
  if (!current) {
    return {
      start: 0,
      end: currentDraft.length,
      replacement: addition,
      nextDraft: addition,
    };
  }
  if (!addition) {
    return {
      start: current.length,
      end: currentDraft.length,
      replacement: "",
      nextDraft: current,
    };
  }
  const replacement = `\n\n${addition}`;
  return {
    start: current.length,
    end: currentDraft.length,
    replacement,
    nextDraft: `${current}${replacement}`,
  };
}

export function appendComposerTransferDraft(
  currentDraft: string,
  text: string,
): string {
  return getComposerTransferReplacement(currentDraft, text).nextDraft;
}

export function appendSlashCommandDraft(
  currentDraft: string,
  command: string,
): string {
  const normalizedCommand =
    command.startsWith("/") || command.startsWith("$")
      ? command
      : `/${command}`;
  const current = currentDraft.trimEnd();
  if (/^[/\\$][^\s/\\$]*$/.test(current)) {
    return `${normalizedCommand} `;
  }
  return current ? `${current} ${normalizedCommand} ` : `${normalizedCommand} `;
}

export function createComposerDraftAttachmentState(
  composerAttachments: readonly ComposerAttachment[],
  updatedAt = new Date().toISOString(),
): DraftAttachmentState | null {
  const stagedRefs = composerAttachments
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  if (stagedRefs.length === 0) {
    return null;
  }

  const batchId = stagedRefs[0]?.batchId;
  if (!batchId) {
    return null;
  }

  return {
    batchId,
    refs: stagedRefs,
    updatedAt,
  };
}

export function splitComposerAttachmentsForSubmission(
  composerAttachments: readonly ComposerAttachment[],
): {
  uploadedFiles: ComposerUploadedAttachment[];
  draftState: DraftAttachmentState | null;
} {
  const uploadedFiles = composerAttachments.filter(
    (attachment): attachment is ComposerUploadedAttachment =>
      !isComposerStagedAttachment(attachment),
  );
  const draftState = createComposerDraftAttachmentState(composerAttachments);
  if (!draftState) {
    return { uploadedFiles, draftState: null };
  }
  if (draftState.refs.some((ref) => ref.batchId !== draftState.batchId)) {
    throw new Error("Draft attachments are split across staging batches");
  }
  return { uploadedFiles, draftState };
}

export async function materializeComposerAttachmentsForSubmission({
  attachments,
  sourceTransport,
  projectId,
  sessionId,
}: {
  attachments: readonly ComposerAttachment[];
  sourceTransport: Pick<SourceTransport, "fetch">;
  projectId: string;
  sessionId: string;
}): Promise<UploadedFile[]> {
  const { uploadedFiles, draftState } =
    splitComposerAttachmentsForSubmission(attachments);
  if (!draftState) {
    return uploadedFiles;
  }

  const materializedFiles = await materializeDraftAttachmentsForSession(
    sourceTransport,
    projectId,
    sessionId,
    draftState,
  );
  return [...uploadedFiles, ...materializedFiles];
}

export async function collectComposerAttachmentsForSubmission({
  currentAttachments,
  pendingUploads,
  setComposerAttachments,
  pendingMessageId,
  updatePendingMessage,
  uploadingStatus,
}: {
  currentAttachments: readonly ComposerAttachment[];
  pendingUploads: readonly Promise<ComposerAttachment | null>[];
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: { persistDraft?: boolean },
  ) => void;
  pendingMessageId?: string;
  updatePendingMessage?: (
    id: string,
    updates: { status?: string | undefined },
  ) => void;
  uploadingStatus?: string;
}): Promise<ComposerAttachment[]> {
  const collectedAttachments = [...currentAttachments];
  const showUploadStatus =
    !!pendingMessageId && pendingUploads.length > 0 && !!uploadingStatus;

  if (showUploadStatus && pendingMessageId) {
    updatePendingMessage?.(pendingMessageId, { status: uploadingStatus });
  }

  try {
    if (pendingUploads.length > 0) {
      setComposerAttachments([], { persistDraft: false });
      const results = await Promise.all(pendingUploads);
      for (const result of results) {
        if (result) collectedAttachments.push(result);
      }

      const sentIds = new Set(
        collectedAttachments.map((attachment) => attachment.id),
      );
      setComposerAttachments(
        (prev) => prev.filter((attachment) => !sentIds.has(attachment.id)),
        { persistDraft: false },
      );
    } else {
      setComposerAttachments([], { persistDraft: false });
    }
  } finally {
    if (showUploadStatus && pendingMessageId) {
      updatePendingMessage?.(pendingMessageId, { status: undefined });
    }
  }

  return collectedAttachments;
}

function imageDimensionOptions(
  width: number | undefined,
  height: number | undefined,
): Pick<UploadOptions, "imageDimensions"> {
  return width !== undefined && height !== undefined
    ? { imageDimensions: { width, height } }
    : {};
}

export async function uploadComposerAttachmentFile({
  file,
  sourceTransport,
  projectId,
  sessionId,
  maxLongEdgePx,
  stagedBatchId,
  onProgress,
}: {
  file: File;
  sourceTransport: Pick<SourceTransport, "upload" | "uploadStagedAttachment">;
  projectId: string;
  sessionId: string;
  maxLongEdgePx: number;
  stagedBatchId?: string | null;
  onProgress?: (bytesUploaded: number, uploadFile: File) => void;
}): Promise<ComposerAttachment> {
  const preparedImage = file.type.startsWith("image/")
    ? await prepareImageUpload(file, maxLongEdgePx)
    : { file };
  const uploadFile = preparedImage.file;
  const uploadOptions: UploadOptions = {
    onProgress: (bytesUploaded) => {
      onProgress?.(bytesUploaded, uploadFile);
    },
    ...imageDimensionOptions(preparedImage.width, preparedImage.height),
  };

  if (stagedBatchId) {
    const previewUrl = uploadFile.type.startsWith("image/")
      ? URL.createObjectURL(uploadFile)
      : undefined;
    try {
      const stagedRef = await sourceTransport.uploadStagedAttachment(
        uploadFile,
        {
          batchId: stagedBatchId,
          ...uploadOptions,
        },
      );
      return {
        ...stagedRef,
        ...(previewUrl ? { previewUrl } : {}),
      } satisfies ComposerStagedAttachment;
    } catch (err) {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      throw err;
    }
  }

  return sourceTransport.upload(
    projectId,
    sessionId,
    uploadFile,
    uploadOptions,
  );
}
