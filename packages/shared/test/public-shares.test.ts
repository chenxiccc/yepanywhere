import { describe, expect, it } from "vitest";
import {
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT,
  isPublicSessionSharePublicMetadata,
  isPublicShareSessionChunksMetadata,
  isPublicShareSessionTransferSizeWithinLimits,
} from "../src/public-shares.js";

const validChunks = {
  revisionId: "revision-1",
  integrityWitness: "witness-1",
  compressedBytes: PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  sessionBytes: PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  maxChunkBytes: PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  capturedAt: "2026-08-06T00:00:00.000Z",
  linkedFileMode: "cow" as const,
};

const validMetadata = {
  mode: "frozen" as const,
  title: "Snapshot",
  initialPrompt: null,
  projectName: "repo",
  provider: "claude",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:01:00.000Z",
  capturedAt: "2026-08-06T00:01:00.000Z",
  linkedFileMode: "cow" as const,
};

describe("public share session transfer limits", () => {
  it("accepts the exact compressed and decompressed ceilings", () => {
    expect(
      isPublicShareSessionTransferSizeWithinLimits(
        PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
        PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
      ),
    ).toBe(true);
    expect(isPublicShareSessionTransferSizeWithinLimits(1, 0)).toBe(true);
    expect(isPublicShareSessionChunksMetadata(validChunks)).toBe(true);
    expect(PUBLIC_SHARE_SESSION_MAX_CHUNK_COUNT).toBe(256);
  });

  it.each([
    ["zero compressed bytes", 0, 0],
    [
      "compressed bytes above the ceiling",
      PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES + 1,
      0,
    ],
    [
      "decompressed bytes above the ceiling",
      1,
      PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES + 1,
    ],
    ["unsafe compressed bytes", Number.MAX_SAFE_INTEGER + 1, 0],
    ["unsafe decompressed bytes", 1, Number.MAX_SAFE_INTEGER + 1],
    ["fractional compressed bytes", 1.5, 0],
    ["fractional decompressed bytes", 1, 1.5],
    ["NaN", Number.NaN, 0],
    ["infinity", 1, Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, compressedBytes, sessionBytes) => {
    expect(
      isPublicShareSessionTransferSizeWithinLimits(
        compressedBytes,
        sessionBytes,
      ),
    ).toBe(false);
  });

  it("requires the fixed chunk size and capability metadata together", () => {
    expect(
      isPublicShareSessionChunksMetadata({
        ...validChunks,
        maxChunkBytes: PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES - 1,
      }),
    ).toBe(false);
    expect(
      isPublicSessionSharePublicMetadata({
        ...validMetadata,
        capabilities: [PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY],
      }),
    ).toBe(false);
    expect(isPublicSessionSharePublicMetadata(validMetadata)).toBe(true);
    expect(
      isPublicSessionSharePublicMetadata({
        ...validMetadata,
        capabilities: [PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY],
        sessionChunks: validChunks,
      }),
    ).toBe(true);
  });
});
