import { describe, expect, it } from "vitest";
import { getSettingsCategories } from "../../../i18n-settings";
import {
  createSettingsDetailNavigationState,
  SETTINGS_TWO_COLUMN_MIN_WIDTH,
  shouldPopSettingsDetailBack,
  shouldReplaceSettingsCategoryNavigation,
  shouldUseSettingsTwoColumn,
} from "../SettingsLayout";

describe("SettingsLayout", () => {
  it("keeps Development immediately before About", () => {
    const categoryIds = getSettingsCategories((key) => key).map(
      (category) => category.id,
    );

    expect(categoryIds.slice(-2)).toEqual(["development", "about"]);
  });

  it("uses the actual settings-container width for the two-column layout", () => {
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_MIN_WIDTH - 1)).toBe(
      false,
    );
    expect(shouldUseSettingsTwoColumn(SETTINGS_TWO_COLUMN_MIN_WIDTH)).toBe(
      true,
    );
  });

  it("marks details opened from the settings list as poppable", () => {
    const state = createSettingsDetailNavigationState(true);

    expect(state).toEqual({ settingsDetailOpenedFromList: true });
    expect(shouldPopSettingsDetailBack(state)).toBe(true);
  });

  it("does not pop settings detail back for unmarked navigation state", () => {
    expect(createSettingsDetailNavigationState(false)).toBe(undefined);
    expect(shouldPopSettingsDetailBack(undefined)).toBe(false);
    expect(shouldPopSettingsDetailBack({ from: "/sessions" })).toBe(false);
  });

  it("replaces history only when switching settings panes in two-column mode", () => {
    expect(
      shouldReplaceSettingsCategoryNavigation({
        currentCategory: "appearance",
        useTwoColumnSettings: true,
      }),
    ).toBe(true);
    expect(
      shouldReplaceSettingsCategoryNavigation({
        currentCategory: undefined,
        useTwoColumnSettings: true,
      }),
    ).toBe(false);
    expect(
      shouldReplaceSettingsCategoryNavigation({
        currentCategory: "appearance",
        useTwoColumnSettings: false,
      }),
    ).toBe(false);
  });
});
