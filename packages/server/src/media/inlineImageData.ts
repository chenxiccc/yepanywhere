export interface ToolResultMediaCandidate {
  dataUrl?: string;
  originalPath?: string;
  claimedMimeType?: string;
  filename?: string;
  width?: number;
  height?: number;
}

export const TOOL_RESULT_MEDIA_CANDIDATES: unique symbol = Symbol(
  "ya.tool-result-media-candidates",
);

export type ToolResultMediaCandidateCarrier = {
  [TOOL_RESULT_MEDIA_CANDIDATES]?: ToolResultMediaCandidate[];
};

const INLINE_IMAGE_DATA_URL_PREFIX_RE =
  /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i;
const INLINE_IMAGE_DATA_URL_GLOBAL_RE =
  /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[A-Za-z0-9+/=_-]+/gi;

export function attachToolResultMediaCandidates(
  value: object,
  candidates: readonly ToolResultMediaCandidate[] | undefined,
): void {
  if (!candidates || candidates.length === 0) return;
  (value as ToolResultMediaCandidateCarrier)[TOOL_RESULT_MEDIA_CANDIDATES] = [
    ...candidates,
  ];
}

export function sanitizeInlineImageData(value: unknown): {
  value: unknown;
  changed: boolean;
  candidates: ToolResultMediaCandidate[];
} {
  if (typeof value === "string") {
    return sanitizeInlineImageText(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const candidates: ToolResultMediaCandidate[] = [];
    const sanitized = value.map((item) => {
      const result = sanitizeInlineImageData(item);
      changed ||= result.changed;
      candidates.push(...result.candidates);
      return result.value;
    });
    return changed
      ? { value: sanitized, changed, candidates }
      : { value, changed, candidates };
  }

  if (!isRecord(value)) {
    return { value, changed: false, candidates: [] };
  }

  const encodedImage = sanitizeEncodedImageObject(value);
  if (encodedImage) return encodedImage;

  let changed = false;
  const candidates: ToolResultMediaCandidate[] = [];
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = sanitizeInlineImageData(item);
    changed ||= result.changed;
    candidates.push(...result.candidates);
    sanitized[key] = result.value;
  }

  return changed
    ? { value: sanitized, changed, candidates }
    : { value, changed, candidates };
}

function sanitizeEncodedImageObject(value: Record<string, unknown>): {
  value: unknown;
  changed: boolean;
  candidates: ToolResultMediaCandidate[];
} | null {
  if (value.type !== "image") return null;

  if (isRecord(value.file) && typeof value.file.base64 === "string") {
    const { base64, ...file } = value.file;
    if (!base64) return null;
    const claimedMimeType =
      typeof value.file.type === "string" ? value.file.type : "image/*";
    const dimensions = isRecord(value.file.dimensions)
      ? value.file.dimensions
      : null;
    return {
      value: { ...value, file },
      changed: true,
      candidates: [
        {
          dataUrl: `data:${claimedMimeType};base64,${base64}`,
          claimedMimeType,
          ...(typeof dimensions?.originalWidth === "number"
            ? { width: dimensions.originalWidth }
            : {}),
          ...(typeof dimensions?.originalHeight === "number"
            ? { height: dimensions.originalHeight }
            : {}),
        },
      ],
    };
  }

  if (
    isRecord(value.source) &&
    value.source.type === "base64" &&
    typeof value.source.data === "string" &&
    value.source.data
  ) {
    const { data, ...source } = value.source;
    const claimedMimeType =
      typeof value.source.media_type === "string"
        ? value.source.media_type
        : "image/*";
    return {
      value: { ...value, source },
      changed: true,
      candidates: [
        {
          dataUrl: `data:${claimedMimeType};base64,${data}`,
          claimedMimeType,
        },
      ],
    };
  }

  return null;
}

export function sanitizeInlineImageText(value: string): {
  value: string;
  changed: boolean;
  candidates: ToolResultMediaCandidate[];
} {
  if (!value.includes("data:image/")) {
    return { value, changed: false, candidates: [] };
  }

  if (value.startsWith("data:image/")) {
    return {
      value: summarizeInlineImageDataUrl(value),
      changed: true,
      candidates: [candidateFromDataUrl(value)],
    };
  }

  const candidates: ToolResultMediaCandidate[] = [];
  const replaced = value.replace(INLINE_IMAGE_DATA_URL_GLOBAL_RE, (match) => {
    candidates.push(candidateFromDataUrl(match));
    return summarizeInlineImageDataUrl(match);
  });
  return { value: replaced, changed: replaced !== value, candidates };
}

function candidateFromDataUrl(dataUrl: string): ToolResultMediaCandidate {
  const match = INLINE_IMAGE_DATA_URL_PREFIX_RE.exec(dataUrl);
  return {
    dataUrl,
    ...(match?.[1] ? { claimedMimeType: match[1].toLowerCase() } : {}),
  };
}

function summarizeInlineImageDataUrl(value: string): string {
  const match = INLINE_IMAGE_DATA_URL_PREFIX_RE.exec(value);
  const mimeType = match?.[1]?.toLowerCase() ?? "image/*";
  const commaIndex = value.indexOf(",");
  const payload = commaIndex >= 0 ? value.slice(commaIndex + 1) : "";
  const bytes = estimateDataUrlPayloadBytes(value, payload);
  return `[inline ${mimeType} data omitted${
    bytes !== undefined ? `, ${formatByteSize(bytes)}` : ""
  }]`;
}

function estimateDataUrlPayloadBytes(
  dataUrl: string,
  payload: string,
): number | undefined {
  if (!payload) return undefined;

  const header = dataUrl.slice(0, Math.max(0, dataUrl.indexOf(",")));
  if (!/;base64(?:;|$)/i.test(header)) {
    try {
      return decodeURIComponent(payload).length;
    } catch {
      return payload.length;
    }
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
