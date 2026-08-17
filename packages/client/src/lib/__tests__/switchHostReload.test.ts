// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  SWITCH_HOST_RELOAD_STORAGE_KEY,
  consumeSwitchHostReload,
  markSwitchHostReload,
  resetSwitchHostReloadConsumptionForTests,
} from "../switchHostReload";

describe("switchHostReload", () => {
  afterEach(() => {
    sessionStorage.clear();
    resetSwitchHostReloadConsumptionForTests();
  });

  it("consumes a marked reload once per document", () => {
    markSwitchHostReload();
    expect(sessionStorage.getItem(SWITCH_HOST_RELOAD_STORAGE_KEY)).toBe("1");
    expect(consumeSwitchHostReload()).toBe(true);
    expect(sessionStorage.getItem(SWITCH_HOST_RELOAD_STORAGE_KEY)).toBeNull();
    expect(consumeSwitchHostReload()).toBe(true);
  });

  it("returns false when Switch Host did not mark this load", () => {
    expect(consumeSwitchHostReload()).toBe(false);
    expect(consumeSwitchHostReload()).toBe(false);
  });
});
