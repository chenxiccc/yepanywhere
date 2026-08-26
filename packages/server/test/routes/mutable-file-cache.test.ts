import { describe, expect, it } from "vitest";
import {
  createMutableFileCacheMetadata,
  createNotModifiedResponse,
  isMutableFileNotModified,
  mutableFileCacheHeaders,
} from "../../src/routes/mutable-file-cache.js";

const STATS = {
  ctimeMs: Date.UTC(2026, 7, 26, 8, 30, 1, 456),
  mtimeMs: Date.UTC(2026, 7, 26, 8, 30, 0, 789),
  size: 31_917,
};

describe("mutable file cache validators", () => {
  it("builds private revalidation headers from file metadata", () => {
    const metadata = createMutableFileCacheMetadata(STATS);

    expect(mutableFileCacheHeaders(metadata)).toEqual({
      "Cache-Control": "private, no-cache",
      ETag: metadata.etag,
      "Last-Modified": "Wed, 26 Aug 2026 08:30:00 GMT",
    });
    expect(metadata.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
  });

  it("uses weak entity-tag comparison and gives it date precedence", () => {
    const metadata = createMutableFileCacheMetadata(STATS);
    const strongEquivalent = metadata.etag.replace(/^W\//, "");

    expect(
      isMutableFileNotModified(
        new Headers({ "If-None-Match": `"other", ${strongEquivalent}` }),
        metadata,
      ),
    ).toBe(true);
    expect(
      isMutableFileNotModified(
        new Headers({
          "If-Modified-Since": metadata.lastModified,
          "If-None-Match": '"different"',
        }),
        metadata,
      ),
    ).toBe(false);
  });

  it("invalidates same-size files whose mtime was preserved", () => {
    const before = createMutableFileCacheMetadata(STATS);
    const after = createMutableFileCacheMetadata({
      ...STATS,
      ctimeMs: STATS.ctimeMs + 1,
    });

    expect(after.etag).not.toBe(before.etag);
  });

  it("accepts an unchanged Last-Modified timestamp at HTTP precision", () => {
    const metadata = createMutableFileCacheMetadata(STATS);

    expect(
      isMutableFileNotModified(
        new Headers({ "If-Modified-Since": metadata.lastModified }),
        metadata,
      ),
    ).toBe(true);
    expect(
      isMutableFileNotModified(
        new Headers({
          "If-Modified-Since": "Wed, 26 Aug 2026 08:29:59 GMT",
        }),
        metadata,
      ),
    ).toBe(false);
  });

  it("omits representation length from 304 responses", () => {
    const response = createNotModifiedResponse(
      new Headers({
        "Cache-Control": "private, no-cache",
        "Content-Length": "31917",
        ETag: createMutableFileCacheMetadata(STATS).etag,
      }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  });
});
