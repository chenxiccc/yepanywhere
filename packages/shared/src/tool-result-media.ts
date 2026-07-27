export const TOOL_RESULT_MEDIA_REJECTION_REASONS = [
  "invalid-image-data",
  "source-unavailable",
  "storage-unavailable",
  "too-large",
  "unsupported-media",
] as const;

export type ToolResultMediaRejectionReason =
  (typeof TOOL_RESULT_MEDIA_REJECTION_REASONS)[number];

export interface StoredToolResultMedia {
  state: "stored";
  toolCallId: string;
  id: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  filename?: string;
}

export interface RejectedToolResultMedia {
  state: "rejected";
  toolCallId: string;
  reason: ToolResultMediaRejectionReason;
  filename?: string;
  claimedMimeType?: string;
}

export type ToolResultMedia = StoredToolResultMedia | RejectedToolResultMedia;
