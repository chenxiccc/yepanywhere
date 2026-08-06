import type { StagedAttachmentRef } from "@yep-anywhere/shared";

export const DRAFT_ENVELOPE_VERSION = 1;

export interface DraftAttachmentState {
  batchId: string;
  refs: StagedAttachmentRef[];
  updatedAt: string;
}

export interface DraftEnvelopeV1 {
  version: typeof DRAFT_ENVELOPE_VERSION;
  text: string;
  attachments?: DraftAttachmentState;
}

export interface DraftEnvelopeReadResult {
  envelope: DraftEnvelopeV1 | null;
  legacy: boolean;
  invalidEnvelope: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeAttachmentRef(value: unknown): StagedAttachmentRef | null {
  if (!isRecord(value)) return null;

  const id = nonEmptyString(value.id);
  const batchId = nonEmptyString(value.batchId);
  const originalName = nonEmptyString(value.originalName);
  const name = nonEmptyString(value.name);
  const mimeType = nonEmptyString(value.mimeType);
  const createdAt = nonEmptyString(value.createdAt);
  const updatedAt = nonEmptyString(value.updatedAt);
  const size = optionalFiniteNumber(value.size);

  if (
    !id ||
    !batchId ||
    !originalName ||
    !name ||
    !mimeType ||
    !createdAt ||
    !updatedAt ||
    size === undefined
  ) {
    return null;
  }

  const width = optionalFiniteNumber(value.width);
  const height = optionalFiniteNumber(value.height);

  return {
    id,
    batchId,
    originalName,
    name,
    size,
    mimeType,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeAttachmentState(value: unknown): DraftAttachmentState | null {
  if (!isRecord(value)) return null;

  const batchId = nonEmptyString(value.batchId);
  const updatedAt = nonEmptyString(value.updatedAt);
  if (!batchId || !updatedAt || !Array.isArray(value.refs)) {
    return null;
  }

  const refs = value.refs
    .map(normalizeAttachmentRef)
    .filter((ref): ref is StagedAttachmentRef => ref !== null);
  if (refs.length === 0) {
    return null;
  }

  return { batchId, refs, updatedAt };
}

function normalizeEnvelope(value: unknown): DraftEnvelopeV1 | null {
  if (!isRecord(value)) return null;
  if (value.version !== DRAFT_ENVELOPE_VERSION) return null;
  if (typeof value.text !== "string") return null;

  const attachments = normalizeAttachmentState(value.attachments);
  return {
    version: DRAFT_ENVELOPE_VERSION,
    text: value.text,
    ...(attachments ? { attachments } : {}),
  };
}

function looksLikeDraftEnvelope(raw: string): boolean {
  return /^\s*\{\s*"version"\s*:/.test(raw);
}

export function readDraftEnvelopeValue(
  raw: string | null | undefined,
): DraftEnvelopeReadResult {
  if (!raw) {
    return { envelope: null, legacy: false, invalidEnvelope: false };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope = normalizeEnvelope(parsed);
    if (envelope) {
      return { envelope, legacy: false, invalidEnvelope: false };
    }

    if (isRecord(parsed) && "version" in parsed) {
      return { envelope: null, legacy: false, invalidEnvelope: true };
    }
  } catch {
    if (looksLikeDraftEnvelope(raw)) {
      return { envelope: null, legacy: false, invalidEnvelope: true };
    }
  }

  return {
    envelope: { version: DRAFT_ENVELOPE_VERSION, text: raw },
    legacy: true,
    invalidEnvelope: false,
  };
}

export function hasDraftEnvelopeContent(
  envelope: DraftEnvelopeV1 | null | undefined,
): boolean {
  return Boolean(
    envelope &&
      (envelope.text.trim() || (envelope.attachments?.refs.length ?? 0) > 0),
  );
}

export function hasDraftContentValue(raw: string | null | undefined): boolean {
  return hasDraftEnvelopeContent(readDraftEnvelopeValue(raw).envelope);
}

export function readDraftTextValue(raw: string | null | undefined): string {
  return readDraftEnvelopeValue(raw).envelope?.text ?? "";
}

export function readDraftAttachmentStateValue(
  raw: string | null | undefined,
): DraftAttachmentState | null {
  return readDraftEnvelopeValue(raw).envelope?.attachments ?? null;
}

export function serializeDraftEnvelope(
  envelope: DraftEnvelopeV1,
): string | null {
  if (!hasDraftEnvelopeContent(envelope)) {
    return null;
  }
  return JSON.stringify(envelope);
}

export function draftStorageValueForText(
  text: string,
  existingRaw?: string | null,
): string | null {
  const existing = readDraftEnvelopeValue(existingRaw).envelope;
  return serializeDraftEnvelope({
    version: DRAFT_ENVELOPE_VERSION,
    text,
    ...(existing?.attachments ? { attachments: existing.attachments } : {}),
  });
}

export function draftStorageValueForAttachments(
  attachments: DraftAttachmentState | null | undefined,
  existingRaw?: string | null,
): string | null {
  const existing = readDraftEnvelopeValue(existingRaw).envelope;
  const nextAttachments =
    attachments && attachments.refs.length > 0 ? attachments : undefined;
  return serializeDraftEnvelope({
    version: DRAFT_ENVELOPE_VERSION,
    text: existing?.text ?? "",
    ...(nextAttachments ? { attachments: nextAttachments } : {}),
  });
}
