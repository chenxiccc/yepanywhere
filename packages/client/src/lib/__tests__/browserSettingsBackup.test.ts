// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_SETTINGS_BACKUP_VERSION } from "@yep-anywhere/shared";
import {
  applyBrowserSettingsBackup,
  captureBrowserSettings,
} from "../browserSettingsBackup";
import { BROWSER_LOCAL_KEYS, UI_KEYS } from "../storageKeys";

describe("browser settings backup", () => {
  afterEach(() => localStorage.clear());

  it("captures portable preferences without identity, secrets, or drafts", () => {
    localStorage.setItem(UI_KEYS.theme, "verydark");
    localStorage.setItem(UI_KEYS.sidebarMinimized, "true");
    localStorage.setItem(UI_KEYS.sidebarSpacing, "compact");
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    localStorage.setItem(UI_KEYS.tooltipDelayMs, "80");
    localStorage.setItem(UI_KEYS.conversationViewTurnLimit, "150");
    localStorage.setItem(UI_KEYS.widerConversationActivityPreviews, "true");
    localStorage.setItem(UI_KEYS.compactMultiImageGalleries, "false");
    localStorage.setItem(BROWSER_LOCAL_KEYS.model, "gpt-5.6");
    localStorage.setItem(BROWSER_LOCAL_KEYS.browserProfileId, "device-1");
    localStorage.setItem(BROWSER_LOCAL_KEYS.xaiSttApiKey, "secret");
    localStorage.setItem("draft-message-session-1", "unfinished");

    expect(captureBrowserSettings()).toEqual({
      [UI_KEYS.theme]: "verydark",
      [UI_KEYS.sidebarMinimized]: "true",
      [UI_KEYS.sidebarSpacing]: "compact",
      [UI_KEYS.tooltipMode]: "native",
      [UI_KEYS.tooltipDelayMs]: "80",
      [UI_KEYS.conversationViewTurnLimit]: "150",
      [UI_KEYS.widerConversationActivityPreviews]: "true",
      [UI_KEYS.compactMultiImageGalleries]: "false",
      [BROWSER_LOCAL_KEYS.model]: "gpt-5.6",
    });
  });

  it("replaces the portable set while leaving unrelated storage intact", () => {
    localStorage.setItem(UI_KEYS.theme, "light");
    localStorage.setItem(UI_KEYS.fontSize, "large");
    localStorage.setItem(BROWSER_LOCAL_KEYS.browserProfileId, "device-1");

    applyBrowserSettingsBackup({
      version: BROWSER_SETTINGS_BACKUP_VERSION,
      savedAt: "2026-07-19T12:00:00.000Z",
      values: { [UI_KEYS.theme]: "verydark" },
    });

    expect(localStorage.getItem(UI_KEYS.theme)).toBe("verydark");
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBeNull();
    expect(localStorage.getItem(BROWSER_LOCAL_KEYS.browserProfileId)).toBe(
      "device-1",
    );
  });
});
