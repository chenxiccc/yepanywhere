export type LimitedJsonBodyFailure =
  | "too-large"
  | "invalid-json"
  | "expected-object";

export class LimitedJsonBodyError extends Error {
  constructor(readonly failure: LimitedJsonBodyFailure) {
    super(failure);
    this.name = "LimitedJsonBodyError";
  }
}

function declaredBodyExceedsLimit(request: Request, maxBytes: number): boolean {
  const rawLength = request.headers.get("Content-Length")?.trim();
  if (!rawLength || !/^\d+$/u.test(rawLength)) return false;
  const length = Number(rawLength);
  return !Number.isSafeInteger(length) || length > maxBytes;
}

async function cancelOverflow(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // Preserve the size-bound failure when the request source cannot cancel.
  }
}

export async function readLimitedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("JSON body limit must be a positive safe integer");
  }
  if (declaredBodyExceedsLimit(request, maxBytes)) {
    throw new LimitedJsonBodyError("too-large");
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new LimitedJsonBodyError("invalid-json");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await cancelOverflow(reader);
        throw new LimitedJsonBodyError("too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new LimitedJsonBodyError("invalid-json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LimitedJsonBodyError("expected-object");
  }
  return value as Record<string, unknown>;
}
