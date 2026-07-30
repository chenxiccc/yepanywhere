import { useCallback, useSyncExternalStore } from "react";
import { UI_KEYS } from "../lib/storageKeys";

interface DeveloperModeSettings {
  /** Expose the experimental all-hosts monitor link */
  multiHostMonitorEnabled: boolean;
  /** Log relay requests/responses to console for debugging */
  relayDebugEnabled: boolean;
  /** Capture connection logs and send to server for debugging */
  remoteLogCollectionEnabled: boolean;
  /** Show connection status bars (green/orange/red) */
  showConnectionBars: boolean;
}

const DEFAULT_SETTINGS: DeveloperModeSettings = {
  multiHostMonitorEnabled: false,
  relayDebugEnabled: false,
  remoteLogCollectionEnabled: false,
  showConnectionBars: false,
};

function getBrowserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeSettings(raw: unknown): DeveloperModeSettings {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_SETTINGS;
  }
  const parsed = raw as Partial<DeveloperModeSettings>;
  return {
    multiHostMonitorEnabled:
      parsed.multiHostMonitorEnabled ??
      DEFAULT_SETTINGS.multiHostMonitorEnabled,
    relayDebugEnabled:
      parsed.relayDebugEnabled ?? DEFAULT_SETTINGS.relayDebugEnabled,
    remoteLogCollectionEnabled:
      parsed.remoteLogCollectionEnabled ??
      DEFAULT_SETTINGS.remoteLogCollectionEnabled,
    showConnectionBars:
      parsed.showConnectionBars ?? DEFAULT_SETTINGS.showConnectionBars,
  };
}

function loadSettings(): DeveloperModeSettings {
  const storage = getBrowserLocalStorage();
  if (!storage || typeof storage.getItem !== "function")
    return DEFAULT_SETTINGS;
  const stored = storage.getItem(UI_KEYS.developerMode);
  if (!stored) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: DeveloperModeSettings) {
  const storage = getBrowserLocalStorage();
  if (!storage || typeof storage.setItem !== "function") return;
  storage.setItem(UI_KEYS.developerMode, JSON.stringify(settings));
}

// Simple external store for cross-component sync
let currentSettings = loadSettings();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSettings;
}

function updateSettings(newSettings: DeveloperModeSettings) {
  currentSettings = newSettings;
  saveSettings(newSettings);
  for (const listener of listeners) {
    listener();
  }
}

export function setRemoteLogCollectionEnabledValue(enabled: boolean): void {
  updateSettings({ ...currentSettings, remoteLogCollectionEnabled: enabled });
}

export function __resetDeveloperModeForTest(): void {
  currentSettings = DEFAULT_SETTINGS;
  const storage = getBrowserLocalStorage();
  if (storage && typeof storage.removeItem === "function") {
    storage.removeItem(UI_KEYS.developerMode);
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Hook to manage developer mode settings.
 * Settings are persisted to localStorage and synced across components.
 */
export function useDeveloperMode() {
  const settings = useSyncExternalStore(subscribe, getSnapshot);

  const setMultiHostMonitorEnabled = useCallback((enabled: boolean) => {
    updateSettings({ ...currentSettings, multiHostMonitorEnabled: enabled });
  }, []);

  const setRelayDebugEnabled = useCallback((enabled: boolean) => {
    updateSettings({ ...currentSettings, relayDebugEnabled: enabled });
  }, []);

  const setRemoteLogCollectionEnabled = useCallback(
    setRemoteLogCollectionEnabledValue,
    [],
  );

  const setShowConnectionBars = useCallback((enabled: boolean) => {
    updateSettings({ ...currentSettings, showConnectionBars: enabled });
  }, []);

  return {
    multiHostMonitorEnabled: settings.multiHostMonitorEnabled,
    setMultiHostMonitorEnabled,
    relayDebugEnabled: settings.relayDebugEnabled,
    setRelayDebugEnabled,
    remoteLogCollectionEnabled: settings.remoteLogCollectionEnabled,
    setRemoteLogCollectionEnabled,
    showConnectionBars: settings.showConnectionBars,
    setShowConnectionBars,
  };
}

/**
 * Get the current relay debug setting without React hooks.
 * Used by SecureConnection to check the setting synchronously.
 */
export function getRelayDebugEnabled(): boolean {
  return currentSettings.relayDebugEnabled;
}

/**
 * Get the current remote log collection setting without React hooks.
 * Used by ClientLogCollector to check the setting synchronously.
 */
export function getRemoteLogCollectionEnabled(): boolean {
  return currentSettings.remoteLogCollectionEnabled;
}

/**
 * Subscribe to developer mode setting changes (non-React).
 * Returns an unsubscribe function.
 */
export function subscribeDeveloperMode(listener: () => void): () => void {
  return subscribe(listener);
}
