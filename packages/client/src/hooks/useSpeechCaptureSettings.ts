import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";
import { releaseSharedSpeechMicStream } from "../lib/speechProviders/sharedMicCapture";

const subscribers = new Set<() => void>();

export const MAX_SPEECH_FOLLOW_UP_LISTEN_MS = 30_000;
export const MAX_SPEECH_ASR_ATTRIBUTION_MS = 5_000;
export const MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH = 64;

export type SpeechMessagePrefixMode =
  | "off"
  | "asr"
  | "stt"
  | "dictation"
  | "custom";

const SPEECH_MESSAGE_PREFIX_MODES = new Set<SpeechMessagePrefixMode>([
  "off",
  "asr",
  "stt",
  "dictation",
  "custom",
]);

function canUseLocalStorage(): boolean {
  return (
    typeof globalThis.localStorage !== "undefined" &&
    typeof globalThis.localStorage.getItem === "function" &&
    typeof globalThis.localStorage.setItem === "function" &&
    typeof globalThis.localStorage.removeItem === "function"
  );
}

export function getSpeechKeepMicWarmSetting(): boolean {
  if (!canUseLocalStorage()) return false;
  return globalThis.localStorage.getItem(UI_KEYS.speechKeepMicWarm) === "true";
}

export function getSpeechReducePlaybackSetting(): boolean {
  if (!canUseLocalStorage()) return true;
  return (
    globalThis.localStorage.getItem(UI_KEYS.speechReducePlayback) !== "false"
  );
}

export function getSpeechMicDeviceIdSetting(): string | null {
  if (!canUseLocalStorage()) return null;
  const deviceId = globalThis.localStorage.getItem(UI_KEYS.speechMicDeviceId);
  return deviceId && deviceId.length > 0 ? deviceId : null;
}

function getClampedMillisecondSetting(key: string, max: number): number {
  if (!canUseLocalStorage()) return 0;
  const parsed = Number(globalThis.localStorage.getItem(key));
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(Math.min(max, Math.max(0, parsed)));
}

export function getSpeechFollowUpListenMsSetting(): number {
  return getClampedMillisecondSetting(
    UI_KEYS.speechFollowUpListenMs,
    MAX_SPEECH_FOLLOW_UP_LISTEN_MS,
  );
}

export function getSpeechAsrAttributionMsSetting(): number {
  return getClampedMillisecondSetting(
    UI_KEYS.speechAsrAttributionMs,
    MAX_SPEECH_ASR_ATTRIBUTION_MS,
  );
}

export function getSpeechMessagePrefixModeSetting(): SpeechMessagePrefixMode {
  if (!canUseLocalStorage()) return "off";
  const stored = globalThis.localStorage.getItem(
    UI_KEYS.speechMessagePrefixMode,
  );
  return SPEECH_MESSAGE_PREFIX_MODES.has(stored as SpeechMessagePrefixMode)
    ? (stored as SpeechMessagePrefixMode)
    : "off";
}

function limitSpeechMessageCustomPrefixInput(value: string): string {
  return (value.split(/\r?\n/, 1)[0] ?? "").slice(
    0,
    MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH,
  );
}

export function cleanSpeechMessageCustomPrefix(value: string): string {
  return limitSpeechMessageCustomPrefixInput(value).trim();
}

export function getSpeechMessageCustomPrefixSetting(): string {
  if (!canUseLocalStorage()) return "";
  return limitSpeechMessageCustomPrefixInput(
    globalThis.localStorage.getItem(UI_KEYS.speechMessageCustomPrefix) ?? "",
  );
}

export function resolveSpeechMessagePrefix(
  mode: SpeechMessagePrefixMode,
  customPrefix: string,
): string | null {
  if (mode === "asr") return "[ASR]";
  if (mode === "stt") return "[STT]";
  if (mode === "dictation") return "[Dictation]";
  if (mode === "custom")
    return cleanSpeechMessageCustomPrefix(customPrefix) || null;
  return null;
}

export function setSpeechKeepMicWarmSetting(enabled: boolean): void {
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(
      UI_KEYS.speechKeepMicWarm,
      enabled ? "true" : "false",
    );
  }
  if (!enabled) {
    releaseSharedSpeechMicStream();
  }
  for (const subscriber of subscribers) subscriber();
}

export function setSpeechReducePlaybackSetting(enabled: boolean): void {
  const previousValue = getSpeechReducePlaybackSetting();
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(
      UI_KEYS.speechReducePlayback,
      enabled ? "true" : "false",
    );
  }
  if (previousValue !== enabled) {
    releaseSharedSpeechMicStream();
  }
  for (const subscriber of subscribers) subscriber();
}

export function setSpeechMicDeviceIdSetting(deviceId: string | null): void {
  const previousDeviceId = getSpeechMicDeviceIdSetting();
  const nextDeviceId = deviceId && deviceId.length > 0 ? deviceId : null;
  if (canUseLocalStorage()) {
    if (nextDeviceId) {
      globalThis.localStorage.setItem(UI_KEYS.speechMicDeviceId, nextDeviceId);
    } else {
      globalThis.localStorage.removeItem(UI_KEYS.speechMicDeviceId);
    }
  }
  if (previousDeviceId !== nextDeviceId) {
    releaseSharedSpeechMicStream();
  }
  for (const subscriber of subscribers) subscriber();
}

function setMillisecondSetting(key: string, value: number, max: number): void {
  const cleanValue = Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(0, value)))
    : 0;
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(key, String(cleanValue));
  }
  for (const subscriber of subscribers) subscriber();
}

export function setSpeechFollowUpListenMsSetting(value: number): void {
  setMillisecondSetting(
    UI_KEYS.speechFollowUpListenMs,
    value,
    MAX_SPEECH_FOLLOW_UP_LISTEN_MS,
  );
}

export function setSpeechAsrAttributionMsSetting(value: number): void {
  setMillisecondSetting(
    UI_KEYS.speechAsrAttributionMs,
    value,
    MAX_SPEECH_ASR_ATTRIBUTION_MS,
  );
}

export function setSpeechMessagePrefixModeSetting(
  mode: SpeechMessagePrefixMode,
): void {
  const cleanMode = SPEECH_MESSAGE_PREFIX_MODES.has(mode) ? mode : "off";
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, cleanMode);
  }
  for (const subscriber of subscribers) subscriber();
}

export function setSpeechMessageCustomPrefixSetting(value: string): void {
  const storedValue = limitSpeechMessageCustomPrefixInput(value);
  if (canUseLocalStorage()) {
    if (storedValue) {
      globalThis.localStorage.setItem(
        UI_KEYS.speechMessageCustomPrefix,
        storedValue,
      );
    } else {
      globalThis.localStorage.removeItem(UI_KEYS.speechMessageCustomPrefix);
    }
  }
  for (const subscriber of subscribers) subscriber();
}

export function useSpeechCaptureSettings() {
  const [keepMicWarm, setKeepMicWarmState] = useState(
    getSpeechKeepMicWarmSetting,
  );
  const [micDeviceId, setMicDeviceIdState] = useState(
    getSpeechMicDeviceIdSetting,
  );
  const [reducePlayback, setReducePlaybackState] = useState(
    getSpeechReducePlaybackSetting,
  );
  const [followUpListenMs, setFollowUpListenMsState] = useState(
    getSpeechFollowUpListenMsSetting,
  );
  const [asrAttributionMs, setAsrAttributionMsState] = useState(
    getSpeechAsrAttributionMsSetting,
  );
  const [speechMessagePrefixMode, setSpeechMessagePrefixModeState] = useState(
    getSpeechMessagePrefixModeSetting,
  );
  const [speechMessageCustomPrefix, setSpeechMessageCustomPrefixState] =
    useState(getSpeechMessageCustomPrefixSetting);
  useEffect(() => {
    const update = () => {
      setKeepMicWarmState(getSpeechKeepMicWarmSetting());
      setMicDeviceIdState(getSpeechMicDeviceIdSetting());
      setReducePlaybackState(getSpeechReducePlaybackSetting());
      setFollowUpListenMsState(getSpeechFollowUpListenMsSetting());
      setAsrAttributionMsState(getSpeechAsrAttributionMsSetting());
      setSpeechMessagePrefixModeState(getSpeechMessagePrefixModeSetting());
      setSpeechMessageCustomPrefixState(getSpeechMessageCustomPrefixSetting());
    };
    subscribers.add(update);
    globalThis.addEventListener?.("storage", update);
    return () => {
      subscribers.delete(update);
      globalThis.removeEventListener?.("storage", update);
    };
  }, []);

  const setKeepMicWarm = useCallback((enabled: boolean) => {
    setSpeechKeepMicWarmSetting(enabled);
  }, []);

  const setMicDeviceId = useCallback((deviceId: string | null) => {
    setSpeechMicDeviceIdSetting(deviceId);
  }, []);

  const setReducePlayback = useCallback((enabled: boolean) => {
    setSpeechReducePlaybackSetting(enabled);
  }, []);

  const setFollowUpListenMs = useCallback((value: number) => {
    setSpeechFollowUpListenMsSetting(value);
  }, []);

  const setAsrAttributionMs = useCallback((value: number) => {
    setSpeechAsrAttributionMsSetting(value);
  }, []);

  const setSpeechMessagePrefixMode = useCallback(
    (mode: SpeechMessagePrefixMode) => {
      setSpeechMessagePrefixModeSetting(mode);
    },
    [],
  );

  const setSpeechMessageCustomPrefix = useCallback((value: string) => {
    setSpeechMessageCustomPrefixSetting(value);
  }, []);

  const speechMessagePrefix = resolveSpeechMessagePrefix(
    speechMessagePrefixMode,
    speechMessageCustomPrefix,
  );

  return {
    keepMicWarm,
    setKeepMicWarm,
    micDeviceId,
    setMicDeviceId,
    reducePlayback,
    setReducePlayback,
    followUpListenMs,
    setFollowUpListenMs,
    asrAttributionMs,
    setAsrAttributionMs,
    speechMessagePrefixMode,
    setSpeechMessagePrefixMode,
    speechMessageCustomPrefix,
    setSpeechMessageCustomPrefix,
    speechMessagePrefix,
  };
}
