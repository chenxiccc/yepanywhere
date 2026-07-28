export const THINKING_PREVIEW_WIDTH_MARGIN_PX = 48;
export const THINKING_PREVIEW_MIN_WIDTH_PX = 256;
export const THINKING_PREVIEW_MAX_WIDTH_PX = 544;
export const THINKING_PREVIEW_DEFAULT_WIDTH_PX = 288;

export interface ThinkingPreviewWidthState {
  id: string;
  targetWidthPx: number;
}

export function updateThinkingPreviewWidth(
  previous: ThinkingPreviewWidthState | null,
  id: string,
  requiredWidthPx: number,
): ThinkingPreviewWidthState {
  const measuredTarget = Math.max(
    THINKING_PREVIEW_MIN_WIDTH_PX,
    Math.min(
      THINKING_PREVIEW_MAX_WIDTH_PX,
      Math.ceil(requiredWidthPx) + THINKING_PREVIEW_WIDTH_MARGIN_PX,
    ),
  );
  if (previous?.id === id && previous.targetWidthPx >= measuredTarget) {
    return previous;
  }
  return { id, targetWidthPx: measuredTarget };
}
