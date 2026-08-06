import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  isHostAwakeBatteryFloorPercent,
  isHostAwakeMode,
} from "../src/host-awake.js";

describe("host-awake contract", () => {
  it("keeps the battery reserve default at ten percent", () => {
    expect(DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT).toBe(10);
  });

  it.each(["off", "idle", "idle-and-closed-lid-on-external-power"])(
    "accepts mode %s",
    (mode) => {
      expect(isHostAwakeMode(mode)).toBe(true);
    },
  );

  it.each(["always", "", null, 1])("rejects mode %j", (mode) => {
    expect(isHostAwakeMode(mode)).toBe(false);
  });

  it.each([1, 10, 100])("accepts battery floor %s", (floor) => {
    expect(isHostAwakeBatteryFloorPercent(floor)).toBe(true);
  });

  it.each([0, 101, 10.5, "10", null])("rejects battery floor %j", (floor) => {
    expect(isHostAwakeBatteryFloorPercent(floor)).toBe(false);
  });
});
