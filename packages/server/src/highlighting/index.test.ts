import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __test__,
  getCachedHighlight,
  highlightCode,
  warmHighlight,
} from "./index.js";

const PYTHON = Array.from(
  { length: 200 },
  (_, i) => `def f${i}(x):\n    return x + ${i}  # comment ${i}`,
).join("\n");

describe("highlightCode", () => {
  beforeEach(() => {
    __test__.clearCache();
  });

  it("returns the retained result for identical content", async () => {
    const first = await highlightCode(PYTHON, "python");
    const second = await highlightCode(PYTHON, "python");

    expect(first).not.toBeNull();
    // Same object, so Source Control's repeated diffs of one file version
    // tokenize it once rather than on every refetch, toggle, and reselection.
    expect(second).toBe(first);
    expect(__test__.cacheSize()).toBe(1);
  });

  it("keys retained results by content and by language", async () => {
    const python = await highlightCode(PYTHON, "python");
    const other = await highlightCode(`${PYTHON}\n# changed`, "python");
    const asText = await highlightCode(PYTHON, "javascript");

    expect(other).not.toBe(python);
    expect(asText).not.toBe(python);
    expect(asText?.language).toBe("javascript");
    expect(__test__.cacheSize()).toBe(3);
  });

  it("retains one entry when concurrent requests miss on the same content", async () => {
    const [a, b] = await Promise.all([
      highlightCode(PYTHON, "python"),
      highlightCode(PYTHON, "python"),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(__test__.cacheSize()).toBe(1);
    // Both raced past the read, so the second write replaced the first. The
    // retained-bytes total must count the survivor once, not both.
    expect(__test__.cacheBytes()).toBe((a?.html.length ?? 0));
  });

  it("caps queued whole-file warms and drops the oldest, not the newest", async () => {
    const source = (i: number) => `${PYTHON}\n# variant ${i}`;
    for (let i = 0; i < 12; i++) warmHighlight(source(i), "python");

    // The newest request is the file being looked at now, so it must survive.
    expect(__test__.pendingWarmCount()).toBeLessThanOrEqual(4);

    await vi.waitFor(
      () => expect(getCachedHighlight(source(11), "python")).not.toBeNull(),
      { timeout: 5000 },
    );
    // The oldest were dropped rather than queued into a long loop stall.
    expect(getCachedHighlight(source(0), "python")).toBeNull();
  });

  it("reports the untruncated line count on a cache hit", async () => {
    const long = Array.from(
      { length: __test__.MAX_LINES + 5 },
      (_, i) => `x = ${i}`,
    ).join("\n");

    const first = await highlightCode(long, "python");
    const second = await highlightCode(long, "python");

    expect(first?.truncated).toBe(true);
    expect(first?.lineCount).toBe(__test__.MAX_LINES + 5);
    expect(second).toEqual(first);
  });
});
