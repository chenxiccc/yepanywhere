import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";
import { releaseSharedSpeechMicStream } from "../lib/speechProviders/sharedMicCapture";

const subscribers = new Set<() => void>();

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

export function getSpeechMicDeviceIdSetting(): string | null {
  if (!canUseLocalStorage()) return null;
  const deviceId = globalThis.localStorage.getItem(UI_KEYS.speechMicDeviceId);
  return deviceId && deviceId.length > 0 ? deviceId : null;
}

export function getSpeechSmoothPausedCapitalizationSetting(): boolean {
  if (!canUseLocalStorage()) return false;
  return (
    globalThis.localStorage.getItem(
      UI_KEYS.speechSmoothPausedCapitalization,
    ) === "true"
  );
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

export function setSpeechSmoothPausedCapitalizationSetting(
  enabled: boolean,
): void {
  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(
      UI_KEYS.speechSmoothPausedCapitalization,
      enabled ? "true" : "false",
    );
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
  const [smoothPausedCapitalization, setSmoothPausedCapitalizationState] =
    useState(getSpeechSmoothPausedCapitalizationSetting);

  useEffect(() => {
    const update = () => {
      setKeepMicWarmState(getSpeechKeepMicWarmSetting());
      setMicDeviceIdState(getSpeechMicDeviceIdSetting());
      setSmoothPausedCapitalizationState(
        getSpeechSmoothPausedCapitalizationSetting(),
      );
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

  const setSmoothPausedCapitalization = useCallback((enabled: boolean) => {
    setSpeechSmoothPausedCapitalizationSetting(enabled);
  }, []);

  return {
    keepMicWarm,
    setKeepMicWarm,
    micDeviceId,
    setMicDeviceId,
    smoothPausedCapitalization,
    setSmoothPausedCapitalization,
  };
}
