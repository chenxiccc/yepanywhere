import { LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES } from "../services/PublicShareService.js";

const MAX_JSON_STRING_INPUT_CHARS = Math.floor(
  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES / 6,
);

type JsonFragment = string;

function prepareJsonValue(value: unknown, key: string): unknown {
  if (
    (typeof value === "object" || typeof value === "bigint") &&
    value !== null
  ) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      value = toJSON.call(value, key);
    }
  }

  if (value instanceof Number || value instanceof String) {
    return value.valueOf();
  }
  if (value instanceof Boolean) {
    return value.valueOf();
  }
  return value;
}

function* serializeJsonString(value: string): Generator<JsonFragment> {
  yield '"';
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(value.length, offset + MAX_JSON_STRING_INPUT_CHARS);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    ) {
      end += 1;
    }
    const encoded = JSON.stringify(value.slice(offset, end));
    yield encoded.slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* serializePreparedJsonValue(
  value: unknown,
  ancestors: Set<object>,
): Generator<JsonFragment> {
  if (value === null) {
    yield "null";
    return;
  }

  switch (typeof value) {
    case "string":
      yield* serializeJsonString(value);
      return;
    case "number":
      yield Number.isFinite(value) ? JSON.stringify(value) : "null";
      return;
    case "boolean":
      yield value ? "true" : "false";
      return;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      throw new Error("Unserializable JSON value reached the encoder");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ",";
        const item = prepareJsonValue(value[index], String(index));
        if (
          item === undefined ||
          typeof item === "function" ||
          typeof item === "symbol"
        ) {
          yield "null";
        } else {
          yield* serializePreparedJsonValue(item, ancestors);
        }
      }
      yield "]";
      return;
    }

    yield "{";
    let emitted = false;
    for (const key of Object.keys(value)) {
      const property = prepareJsonValue(
        (value as Record<string, unknown>)[key],
        key,
      );
      if (
        property === undefined ||
        typeof property === "function" ||
        typeof property === "symbol"
      ) {
        continue;
      }
      if (emitted) yield ",";
      yield* serializeJsonString(key);
      yield ":";
      yield* serializePreparedJsonValue(property, ancestors);
      emitted = true;
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

async function* serializeJsonValue(value: unknown): AsyncGenerator<Uint8Array> {
  const prepared = prepareJsonValue(value, "");
  if (
    prepared === undefined ||
    typeof prepared === "function" ||
    typeof prepared === "symbol"
  ) {
    throw new Error("Public share response contains an unserializable value");
  }

  let pending = Buffer.allocUnsafe(
    LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
  );
  let pendingBytes = 0;
  for (const fragment of serializePreparedJsonValue(prepared, new Set())) {
    const bytes = Buffer.from(fragment);
    for (let offset = 0; offset < bytes.byteLength; ) {
      const copied = bytes.copy(
        pending,
        pendingBytes,
        offset,
        offset +
          Math.min(
            bytes.byteLength - offset,
            LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES - pendingBytes,
          ),
      );
      offset += copied;
      pendingBytes += copied;
      if (pendingBytes === LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES) {
        yield pending;
        pending = Buffer.allocUnsafe(
          LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
        );
        pendingBytes = 0;
      }
    }
  }
  if (pendingBytes > 0) yield pending.subarray(0, pendingBytes);
}

export function legacyPublicShareResponseStream(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

export async function* serializeLegacyPublicShareResponse(
  share: object,
  sessionChunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from('{"share":');
  yield* serializeJsonValue(share);
  yield Buffer.from(',"session":');
  yield* sessionChunks;
  yield Buffer.from("}");
}

export { serializeJsonValue as serializeLegacyJsonValue };
