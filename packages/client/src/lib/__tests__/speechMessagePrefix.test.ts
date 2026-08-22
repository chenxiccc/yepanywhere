// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanSpeechMessageCustomPrefix,
  getSpeechMessageCustomPrefixSetting,
  getSpeechMessagePrefixModeSetting,
  MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH,
  resolveSpeechMessagePrefix,
  setSpeechMessageCustomPrefixSetting,
} from "../../hooks/useSpeechCaptureSettings";
import {
  getSpeechPrefixCueLabel,
  prependSpeechMessagePrefix,
  resolveDeliverySpeechPrefix,
} from "../speechMessagePrefix";
import { UI_KEYS } from "../storageKeys";

describe("speech message prefixes", () => {
  afterEach(() => localStorage.clear());

  it("defaults to the microphone prefix and rejects unknown stored modes", () => {
    expect(getSpeechMessagePrefixModeSetting()).toBe("microphone");
    localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "unexpected");
    expect(getSpeechMessagePrefixModeSetting()).toBe("off");
  });

  it.each([
    ["off", null],
    ["microphone", "🎤"],
    ["asr", "[ASR]"],
    ["stt", "[STT]"],
    ["dictation", "[Dictation]"],
    ["custom", "Needs review:"],
  ] as const)("resolves %s to the exact configured value", (mode, expected) => {
    expect(resolveSpeechMessagePrefix(mode, " Needs review: ")).toBe(expected);
  });

  it("cleans custom values to one trimmed bounded line", () => {
    expect(cleanSpeechMessageCustomPrefix("  First line\nSecond line  ")).toBe(
      "First line",
    );
    expect(cleanSpeechMessageCustomPrefix("x".repeat(100))).toHaveLength(
      MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH,
    );
    expect(resolveSpeechMessagePrefix("custom", "  \nignored")).toBeNull();
  });

  it("preserves an in-progress word separator while editing custom text", () => {
    setSpeechMessageCustomPrefixSetting("Needs ");
    expect(getSpeechMessageCustomPrefixSetting()).toBe("Needs ");
    expect(resolveSpeechMessagePrefix("custom", "Needs ")).toBe("Needs");
  });

  it("uses the prefix for speech-triggered or recent-speech delivery only", () => {
    expect(
      resolveDeliverySpeechPrefix({
        configuredPrefix: "[STT]",
        speechTriggered: true,
        recentSpeech: false,
      }),
    ).toBe("[STT]");
    expect(
      resolveDeliverySpeechPrefix({
        configuredPrefix: "[STT]",
        speechTriggered: false,
        recentSpeech: true,
      }),
    ).toBe("[STT]");
    expect(
      resolveDeliverySpeechPrefix({
        configuredPrefix: "[STT]",
        speechTriggered: false,
        recentSpeech: false,
      }),
    ).toBeNull();
    expect(
      resolveDeliverySpeechPrefix({
        configuredPrefix: null,
        speechTriggered: true,
        recentSpeech: true,
      }),
    ).toBeNull();
  });

  it("decorates once and exposes concise preset cue labels", () => {
    expect(prependSpeechMessagePrefix("hello", "🎤")).toBe("🎤 hello");
    expect(prependSpeechMessagePrefix("  hello  ", "[Dictation]")).toBe(
      "[Dictation] hello",
    );
    expect(prependSpeechMessagePrefix("hello", null)).toBe("hello");
    expect(getSpeechPrefixCueLabel("[ASR]")).toBe("ASR");
    expect(getSpeechPrefixCueLabel("Review needed:")).toBe("Review needed:");
  });
});
