import { describe, expect, it } from "vitest";
import { getCodexRolloutActivityTimeMs } from "../../src/utils/codexRolloutFiles.js";

describe("getCodexRolloutActivityTimeMs", () => {
  const stats = { mtimeMs: 100, ctimeMs: 200 };

  it("uses Windows change time for an open plain rollout", () => {
    expect(
      getCodexRolloutActivityTimeMs("rollout-session.jsonl", stats, "win32"),
    ).toBe(200);
    expect(
      getCodexRolloutActivityTimeMs(
        "rollout-session.jsonl",
        { mtimeMs: 300, ctimeMs: 200 },
        "win32",
      ),
    ).toBe(300);
  });

  it("keeps mtime on non-Windows platforms", () => {
    expect(
      getCodexRolloutActivityTimeMs("rollout-session.jsonl", stats, "darwin"),
    ).toBe(100);
    expect(
      getCodexRolloutActivityTimeMs("rollout-session.jsonl", stats, "linux"),
    ).toBe(100);
  });

  it("keeps mtime for immutable compressed rollouts on Windows", () => {
    expect(
      getCodexRolloutActivityTimeMs(
        "rollout-session.jsonl.zst",
        stats,
        "win32",
      ),
    ).toBe(100);
  });

  it("falls back to mtime when change time is unavailable", () => {
    expect(
      getCodexRolloutActivityTimeMs(
        "rollout-session.jsonl",
        { mtimeMs: 100, ctimeMs: Number.NaN },
        "win32",
      ),
    ).toBe(100);
  });
});
