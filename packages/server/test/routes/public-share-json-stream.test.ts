import { describe, expect, it, vi } from "vitest";
import { serializeLegacyJsonValue } from "../../src/routes/public-share-json-stream.js";
import { LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES } from "../../src/services/PublicShareService.js";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    expect(chunk.byteLength).toBeLessThanOrEqual(
      LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
    );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe("public share JSON streaming", () => {
  it("matches JSON.stringify across nested values and string boundaries", async () => {
    const value = {
      escaped: 'quote " slash \\ controls \b\t\n\f\r\0',
      unicode: `before-${"x".repeat(10_921)}-😀-\ud800-after`,
      finite: -12.5,
      nonFinite: Number.POSITIVE_INFINITY,
      omitted: undefined,
      list: [undefined, () => undefined, Symbol("omitted"), true, null],
      date: new Date("2026-08-06T00:00:00.000Z"),
    };

    const expected = JSON.stringify(value);
    const actual = await collect(serializeLegacyJsonValue(value));

    expect(actual.toString("utf8")).toBe(expected);
  });

  it("never stringifies the aggregate live-session object", async () => {
    const messages = Array.from({ length: 256 }, (_, index) => ({
      id: index,
      content: `${index}:${"content".repeat(4096)}`,
    }));
    const value = { id: "session-1", messages };
    const expected = JSON.stringify(value);
    const nativeStringify = JSON.stringify;
    const stringify = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((input: unknown) => {
        if (typeof input === "object" && input !== null) {
          throw new Error("aggregate JSON materialization");
        }
        return nativeStringify(input);
      });

    try {
      const actual = await collect(serializeLegacyJsonValue(value));
      expect(actual.toString("utf8")).toBe(expected);
    } finally {
      stringify.mockRestore();
    }
  });
});
