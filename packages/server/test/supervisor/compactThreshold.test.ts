import { describe, expect, it } from "vitest";
import {
  crossesCompactThreshold,
  resolveNativeCompactTokenLimit,
  shouldYaOrchestrateCompactThreshold,
} from "../../src/supervisor/Supervisor.js";

describe("crossesCompactThreshold (task 029 per-model compact-early gate)", () => {
  const ONE_M = 1_000_000;

  it("fires once live usage reaches percent% of the window", () => {
    // 20% of 1M = 200K.
    expect(crossesCompactThreshold(20, ONE_M, 199_999)).toBe(false);
    expect(crossesCompactThreshold(20, ONE_M, 200_000)).toBe(true);
    expect(crossesCompactThreshold(20, ONE_M, 850_000)).toBe(true);
  });

  it("scales with the model's window, not a fixed token count", () => {
    // 20% of a 200K window = 40K.
    expect(crossesCompactThreshold(20, 200_000, 39_999)).toBe(false);
    expect(crossesCompactThreshold(20, 200_000, 40_000)).toBe(true);
  });

  it("treats out-of-range percents as off", () => {
    expect(crossesCompactThreshold(0, ONE_M, 999_999)).toBe(false);
    expect(crossesCompactThreshold(100, ONE_M, 999_999)).toBe(false);
    expect(crossesCompactThreshold(150, ONE_M, 999_999)).toBe(false);
    expect(crossesCompactThreshold(-5, ONE_M, 999_999)).toBe(false);
  });

  it("never fires on unknown usage or window", () => {
    expect(crossesCompactThreshold(20, ONE_M, undefined)).toBe(false);
    expect(crossesCompactThreshold(20, undefined, 500_000)).toBe(false);
    expect(crossesCompactThreshold(undefined, ONE_M, 500_000)).toBe(false);
    expect(crossesCompactThreshold(20, 0, 500_000)).toBe(false);
    expect(crossesCompactThreshold(20, ONE_M, Number.NaN)).toBe(false);
  });
});

describe("native compact-threshold routing", () => {
  const nativeProvider = { supportsNativeCompactThreshold: true };
  const emulatedProvider = {};

  it("derives a whole-token limit only for an explicit valid threshold", () => {
    expect(
      resolveNativeCompactTokenLimit(nativeProvider, {
        compactAtContextPercent: 25,
        compactAtContextWindow: 272_000,
      }),
    ).toBe(68_000);
    expect(resolveNativeCompactTokenLimit(nativeProvider, {})).toBeUndefined();
    expect(
      resolveNativeCompactTokenLimit(nativeProvider, {
        compactAtContextPercent: 25,
      }),
    ).toBeUndefined();
  });

  it("omits the native limit when YA orchestration is forced", () => {
    expect(
      resolveNativeCompactTokenLimit(nativeProvider, {
        compactAtContextPercent: 25,
        compactAtContextWindow: 272_000,
        forceYaOrchestratedCompaction: true,
      }),
    ).toBeUndefined();
    expect(shouldYaOrchestrateCompactThreshold(nativeProvider, true)).toBe(
      true,
    );
  });

  it("uses YA orchestration only when native support is absent or bypassed", () => {
    expect(shouldYaOrchestrateCompactThreshold(nativeProvider, false)).toBe(
      false,
    );
    expect(shouldYaOrchestrateCompactThreshold(emulatedProvider, false)).toBe(
      true,
    );
  });
});
