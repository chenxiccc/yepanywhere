// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  getSpeechUnspokenPunctuationSetting,
  setSpeechUnspokenPunctuationSetting,
} from "../../hooks/useSpeechCaptureSettings";
import { UI_KEYS } from "../storageKeys";

describe("browser-native inferred punctuation preference", () => {
  afterEach(() => localStorage.clear());

  it("defaults off and persists an explicit choice", () => {
    expect(getSpeechUnspokenPunctuationSetting()).toBe(false);

    setSpeechUnspokenPunctuationSetting(true);
    expect(getSpeechUnspokenPunctuationSetting()).toBe(true);
    expect(localStorage.getItem(UI_KEYS.speechUnspokenPunctuation)).toBe(
      "true",
    );

    setSpeechUnspokenPunctuationSetting(false);
    expect(getSpeechUnspokenPunctuationSetting()).toBe(false);
  });
});
