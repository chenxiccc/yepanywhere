export const ATTACHMENT_HOVER_VIEWPORT_MARGIN_PX = 12;
export const ATTACHMENT_HOVER_GAP_PX = 8;

export interface AttachmentHoverBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PlaceAttachmentHoverPreviewInput {
  anchor: AttachmentHoverBox;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function fitSize(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } | null {
  if (maxWidth < 1 || maxHeight < 1) return null;
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, width * scale),
    height: Math.max(1, height * scale),
  };
}

function area(size: { width: number; height: number }): number {
  return size.width * size.height;
}

function clampLeft(
  preferredLeft: number,
  width: number,
  margin: number,
  viewportWidth: number,
): number {
  return clamp(preferredLeft, margin, viewportWidth - margin - width);
}

/**
 * Anchor a full-image hover preview to its thumbnail. Prefer below, then
 * above, then right, then left — using the first side that can show the image
 * at a useful size, otherwise the side with the largest fitted area.
 */
export function placeAttachmentHoverPreview({
  anchor,
  imageWidth,
  imageHeight,
  viewportWidth,
  viewportHeight,
  margin = ATTACHMENT_HOVER_VIEWPORT_MARGIN_PX,
  gap = ATTACHMENT_HOVER_GAP_PX,
}: PlaceAttachmentHoverPreviewInput): AttachmentHoverBox {
  const maxViewportWidth = Math.max(1, viewportWidth - margin * 2);
  const maxViewportHeight = Math.max(1, viewportHeight - margin * 2);
  const viewportFit = fitSize(
    imageWidth,
    imageHeight,
    maxViewportWidth,
    maxViewportHeight,
  ) ?? { width: 1, height: 1 };
  const usefulArea = area(viewportFit) * 0.5;
  const anchorCenterX = anchor.left + anchor.width / 2;
  const anchorCenterY = anchor.top + anchor.height / 2;

  const candidates: Array<{
    size: { width: number; height: number };
    box: AttachmentHoverBox;
    useful: boolean;
  }> = [];

  const belowMaxHeight =
    viewportHeight - margin - (anchor.top + anchor.height + gap);
  const belowFit = fitSize(
    imageWidth,
    imageHeight,
    maxViewportWidth,
    belowMaxHeight,
  );
  if (belowFit) {
    candidates.push({
      size: belowFit,
      useful: area(belowFit) >= usefulArea,
      box: {
        top: anchor.top + anchor.height + gap,
        left: clampLeft(
          anchorCenterX - belowFit.width / 2,
          belowFit.width,
          margin,
          viewportWidth,
        ),
        width: belowFit.width,
        height: belowFit.height,
      },
    });
  }

  const aboveMaxHeight = anchor.top - gap - margin;
  const aboveFit = fitSize(
    imageWidth,
    imageHeight,
    maxViewportWidth,
    aboveMaxHeight,
  );
  if (aboveFit) {
    candidates.push({
      size: aboveFit,
      useful: area(aboveFit) >= usefulArea,
      box: {
        top: anchor.top - gap - aboveFit.height,
        left: clampLeft(
          anchorCenterX - aboveFit.width / 2,
          aboveFit.width,
          margin,
          viewportWidth,
        ),
        width: aboveFit.width,
        height: aboveFit.height,
      },
    });
  }

  const rightMaxWidth =
    viewportWidth - margin - (anchor.left + anchor.width + gap);
  const rightFit = fitSize(
    imageWidth,
    imageHeight,
    rightMaxWidth,
    maxViewportHeight,
  );
  if (rightFit) {
    candidates.push({
      size: rightFit,
      useful: area(rightFit) >= usefulArea,
      box: {
        top: clamp(
          anchorCenterY - rightFit.height / 2,
          margin,
          viewportHeight - margin - rightFit.height,
        ),
        left: anchor.left + anchor.width + gap,
        width: rightFit.width,
        height: rightFit.height,
      },
    });
  }

  const leftMaxWidth = anchor.left - gap - margin;
  const leftFit = fitSize(
    imageWidth,
    imageHeight,
    leftMaxWidth,
    maxViewportHeight,
  );
  if (leftFit) {
    candidates.push({
      size: leftFit,
      useful: area(leftFit) >= usefulArea,
      box: {
        top: clamp(
          anchorCenterY - leftFit.height / 2,
          margin,
          viewportHeight - margin - leftFit.height,
        ),
        left: anchor.left - gap - leftFit.width,
        width: leftFit.width,
        height: leftFit.height,
      },
    });
  }

  const usefulCandidate = candidates.find((candidate) => candidate.useful);
  const chosen =
    usefulCandidate ??
    candidates.reduce<(typeof candidates)[number] | null>(
      (best, candidate) =>
        !best || area(candidate.size) > area(best.size) ? candidate : best,
      null,
    );

  if (chosen) {
    return chosen.box;
  }

  return {
    top: margin,
    left: margin,
    width: viewportFit.width,
    height: viewportFit.height,
  };
}
