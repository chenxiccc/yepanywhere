import type {
  ClientDefaults,
  ToolbarControlPresence,
  ToolbarNarrowingPriority,
} from "@yep-anywhere/shared";
import {
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../api/client";
import {
  type DefaultedEnumRecord,
  normalizeDefaultedEnumRecord,
  resolveDefaultedEnumRecord,
  setDefaultedEnumRecordValue,
} from "../lib/defaultedStorage";
import {
  serverSupportsProjectQueue,
  serverSupportsProjectQueueNewSessionShortcutSetting,
} from "../lib/projectQueueVisibility";
import { UI_KEYS } from "../lib/storageKeys";
import { setConversationViewPreference } from "./useConversationView";
import { useVersion } from "./useVersion";

export type { ToolbarControlPresence, ToolbarNarrowingPriority };

/**
 * One presence value per toolbar control: `hidden` keeps it off the toolbar;
 * a narrowing-priority tier shows it with that collapse behavior. `off` is
 * reserved for controls whose underlying behavior can be disabled.
 */
export interface SessionToolbarPresence {
  modeSelector: ToolbarControlPresence;
  steerNow: ToolbarControlPresence;
  attachments: ToolbarControlPresence;
  slashMenu: ToolbarControlPresence;
  thinkingToggle: ToolbarControlPresence;
  renderMode: ToolbarControlPresence;
  conversationView: ToolbarControlPresence;
  browserDebug: ToolbarControlPresence;
  microphone: ToolbarControlPresence;
  waveform: ToolbarControlPresence;
  shortcutsHelp: ToolbarControlPresence;
  contextUsage: ToolbarControlPresence;
  btw: ToolbarControlPresence;
  nudge: ToolbarControlPresence;
  sessionStatus: ToolbarControlPresence;
  projectQueue: ToolbarControlPresence;
  projectQueueNewSessionShortcut: ToolbarControlPresence;
  syntheticDone: ToolbarControlPresence;
  /**
   * Composer opener for the prior-turn recall drawer. Shown only in the mobile
   * keyboard action row, never on the toolbar proper, so it has no narrowing
   * tier of its own. See topics/composer-recall-drawer.md.
   */
  composerRecall: ToolbarControlPresence;
}

export type SessionToolbarVisibilityKey = keyof SessionToolbarPresence;

/** Render-time projections of the presence map for the toolbar runtime. */
export type SessionToolbarVisibility = Record<
  SessionToolbarVisibilityKey,
  boolean
>;
export type SessionToolbarPriority = Record<
  SessionToolbarVisibilityKey,
  ToolbarNarrowingPriority
>;

export const DEFAULT_SESSION_TOOLBAR_PRESENCE: SessionToolbarPresence = {
  modeSelector: "first",
  steerNow: "pin",
  attachments: "first",
  slashMenu: "mid",
  thinkingToggle: "mid",
  renderMode: "hidden",
  conversationView: "last",
  browserDebug: "hidden",
  microphone: "pin",
  waveform: "pin",
  shortcutsHelp: "last",
  contextUsage: "pin",
  btw: "hidden",
  nudge: "hidden",
  sessionStatus: "pin",
  projectQueue: "hidden",
  projectQueueNewSessionShortcut: "hidden",
  syntheticDone: "off",
  composerRecall: "hidden",
};

/**
 * Tier a control takes when shown without a tier of its own: the priority
 * projection for hidden controls, and the tier a legacy explicit
 * "visible: true" migrates to. Also the toolbar runtime's fallback when it
 * renders without a priority prop.
 */
export const DEFAULT_SESSION_TOOLBAR_PRIORITY: SessionToolbarPriority = {
  modeSelector: "first",
  steerNow: "pin",
  attachments: "first",
  slashMenu: "mid",
  thinkingToggle: "mid",
  renderMode: "last",
  conversationView: "last",
  browserDebug: "pin",
  microphone: "pin",
  waveform: "pin",
  shortcutsHelp: "last",
  contextUsage: "pin",
  btw: "pin",
  nudge: "last",
  sessionStatus: "pin",
  projectQueue: "pin",
  projectQueueNewSessionShortcut: "pin",
  syntheticDone: "pin",
  composerRecall: "pin",
};

export const SESSION_TOOLBAR_CONTROL_KEYS = Object.keys(
  DEFAULT_SESSION_TOOLBAR_PRESENCE,
) as SessionToolbarVisibilityKey[];

const MOBILE_SESSION_TOOLBAR_PRESENCE_DEFAULTS: Partial<SessionToolbarPresence> =
  {
    shortcutsHelp: "hidden",
    sessionStatus: "hidden",
  };

const SESSION_TOOLBAR_MOBILE_QUERY = "(max-width: 600px)";

function isMobileToolbarLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SESSION_TOOLBAR_MOBILE_QUERY).matches
  );
}

type StoredSessionToolbarPresence = DefaultedEnumRecord<
  SessionToolbarVisibilityKey,
  ToolbarControlPresence
>;
type SessionToolbarPresenceDefaults = Partial<SessionToolbarPresence>;

function isToolbarNarrowingPriority(
  value: unknown,
): value is ToolbarNarrowingPriority {
  return (
    value === "pin" || value === "last" || value === "mid" || value === "first"
  );
}

function isToolbarControlPresence(
  value: unknown,
): value is ToolbarControlPresence {
  return (
    value === "off" || value === "hidden" || isToolbarNarrowingPriority(value)
  );
}

function normalizeClientDefaultPresence(
  value: ClientDefaults["sessionToolbarPresence"] | undefined,
): SessionToolbarPresenceDefaults {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalized: SessionToolbarPresenceDefaults = {};
  const presenceRecord = value as Record<string, unknown>;
  for (const key of SESSION_TOOLBAR_CONTROL_KEYS) {
    if (key === "conversationView" || key === "browserDebug") continue;
    const candidate = presenceRecord[key];
    if (isToolbarControlPresence(candidate)) {
      normalized[key] = candidate;
    }
  }
  return normalized;
}

function getDefaultSessionToolbarPresence(): SessionToolbarPresence {
  const layoutDefaults = isMobileToolbarLayout()
    ? {
        ...DEFAULT_SESSION_TOOLBAR_PRESENCE,
        ...MOBILE_SESSION_TOOLBAR_PRESENCE_DEFAULTS,
      }
    : DEFAULT_SESSION_TOOLBAR_PRESENCE;
  return {
    ...layoutDefaults,
    ...currentClientDefaultPresence,
  };
}

function hasLocalStorage(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function" &&
    typeof localStorage.setItem === "function"
  );
}

function resolvePresence(
  stored: StoredSessionToolbarPresence,
): SessionToolbarPresence {
  return resolveDefaultedEnumRecord(
    stored,
    getDefaultSessionToolbarPresence(),
    SESSION_TOOLBAR_CONTROL_KEYS,
  );
}

function normalizeStoredPresence(value: unknown): StoredSessionToolbarPresence {
  return normalizeDefaultedEnumRecord(
    value,
    SESSION_TOOLBAR_CONTROL_KEYS,
    isToolbarControlPresence,
  );
}

function readLegacyStoredRecord(key: string): Record<string, unknown> | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Fold pre-presence stored state (a visibility boolean map plus a
 * narrowing-priority map under separate keys) into one presence map, persist
 * it, and drop the legacy keys. Explicit `false` visibility becomes `hidden`;
 * an explicit tier (or explicit `true` visibility, via the default tier)
 * becomes that tier.
 */
function migrateLegacyStoredPresence(): StoredSessionToolbarPresence {
  const legacyVisibility = readLegacyStoredRecord(
    UI_KEYS.sessionToolbarVisibility,
  );
  const legacyPriority = readLegacyStoredRecord(UI_KEYS.sessionToolbarPriority);
  if (!legacyVisibility && !legacyPriority) {
    return {};
  }
  const migrated: Partial<
    Record<SessionToolbarVisibilityKey, ToolbarControlPresence>
  > = {};
  for (const key of SESSION_TOOLBAR_CONTROL_KEYS) {
    const visible = legacyVisibility?.[key];
    const tier = legacyPriority?.[key];
    if (visible === false) {
      migrated[key] = "hidden";
    } else if (isToolbarNarrowingPriority(tier)) {
      migrated[key] = tier;
    } else if (visible === true) {
      migrated[key] = DEFAULT_SESSION_TOOLBAR_PRIORITY[key];
    }
  }
  const normalized = normalizeStoredPresence(migrated);
  saveStoredPresence(normalized);
  localStorage.removeItem(UI_KEYS.sessionToolbarVisibility);
  localStorage.removeItem(UI_KEYS.sessionToolbarPriority);
  return normalized;
}

function loadStoredPresence(): StoredSessionToolbarPresence {
  if (!hasLocalStorage()) {
    return {};
  }
  const stored = localStorage.getItem(UI_KEYS.sessionToolbarPresence);
  if (stored) {
    try {
      return normalizeStoredPresence(JSON.parse(stored));
    } catch {
      return {};
    }
  }
  return migrateLegacyStoredPresence();
}

function saveStoredPresence(presence: StoredSessionToolbarPresence): void {
  if (!hasLocalStorage()) {
    return;
  }
  if (Object.keys(presence).length === 0) {
    localStorage.removeItem(UI_KEYS.sessionToolbarPresence);
    return;
  }
  localStorage.setItem(
    UI_KEYS.sessionToolbarPresence,
    JSON.stringify(presence),
  );
}

let currentStoredPresence = loadStoredPresence();
let currentClientDefaultPresence: SessionToolbarPresenceDefaults = {};
let currentPresence = resolvePresence(currentStoredPresence);
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentPresence;
}

function updateStoredPresence(next: StoredSessionToolbarPresence): void {
  currentStoredPresence = normalizeStoredPresence(next);
  currentPresence = resolvePresence(currentStoredPresence);
  saveStoredPresence(currentStoredPresence);
  for (const listener of listeners) {
    listener();
  }
}

function updateClientDefaultPresence(
  next: ClientDefaults["sessionToolbarPresence"] | undefined,
): void {
  currentClientDefaultPresence = normalizeClientDefaultPresence(next);
  currentPresence = resolvePresence(currentStoredPresence);
  for (const listener of listeners) {
    listener();
  }
}

function saveClientDefaultPresence(
  key: SessionToolbarVisibilityKey,
  presence: ToolbarControlPresence,
): void {
  // These controls are client-only preferences so stable servers never need
  // to recognize their new toolbar keys.
  if (key === "conversationView" || key === "browserDebug") {
    return;
  }
  void api
    .updateServerSettings({
      clientDefaults: {
        sessionToolbarPresence: { [key]: presence },
      },
    })
    .catch((err) => {
      console.warn(
        "[useSessionToolbarPresence] Failed to save server client default:",
        err instanceof Error ? err.message : String(err),
      );
    });
}

export function useSessionToolbarPresence() {
  const { version } = useVersion();
  const presence = useSyncExternalStore(subscribe, getSnapshot);
  const effectivePresence = useMemo<SessionToolbarPresence>(
    () => ({
      ...presence,
      projectQueue: serverSupportsProjectQueue(version)
        ? presence.projectQueue
        : "hidden",
      projectQueueNewSessionShortcut:
        serverSupportsProjectQueueNewSessionShortcutSetting(version)
          ? presence.projectQueueNewSessionShortcut
          : "hidden",
      syntheticDone: serverHasCapability(
        version,
        SYNTHETIC_DONE_COMMAND_CAPABILITY,
      )
        ? presence.syntheticDone
        : "off",
      browserDebug: serverHasCapability(
        version,
        REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
      )
        ? presence.browserDebug
        : "hidden",
    }),
    [presence, version],
  );

  useEffect(() => {
    if (!version) return;
    updateClientDefaultPresence(
      version?.clientDefaults?.sessionToolbarPresence,
    );
  }, [version]);

  const setControlPresence = useCallback(
    (key: SessionToolbarVisibilityKey, value: ToolbarControlPresence) => {
      const enablesConversationView =
        key === "conversationView" &&
        currentPresence.conversationView === "hidden" &&
        value !== "hidden";
      updateStoredPresence(
        setDefaultedEnumRecordValue(currentStoredPresence, key, value),
      );
      if (enablesConversationView) {
        setConversationViewPreference(true);
      }
      saveClientDefaultPresence(key, value);
    },
    [],
  );

  const resetPresence = useCallback(() => {
    const enablesConversationView =
      currentPresence.conversationView === "hidden" &&
      getDefaultSessionToolbarPresence().conversationView !== "hidden";
    updateStoredPresence({});
    if (enablesConversationView) {
      setConversationViewPreference(true);
    }
  }, []);

  const visibility = useMemo<SessionToolbarVisibility>(() => {
    const derived = {} as SessionToolbarVisibility;
    for (const key of SESSION_TOOLBAR_CONTROL_KEYS) {
      derived[key] = isToolbarNarrowingPriority(effectivePresence[key]);
    }
    return derived;
  }, [effectivePresence]);

  const priority = useMemo<SessionToolbarPriority>(() => {
    const derived = {} as SessionToolbarPriority;
    for (const key of SESSION_TOOLBAR_CONTROL_KEYS) {
      const value = effectivePresence[key];
      derived[key] = isToolbarNarrowingPriority(value)
        ? value
        : DEFAULT_SESSION_TOOLBAR_PRIORITY[key];
    }
    return derived;
  }, [effectivePresence]);

  return useMemo(
    () => ({
      presence: effectivePresence,
      visibility,
      priority,
      setControlPresence,
      resetPresence,
    }),
    [
      effectivePresence,
      visibility,
      priority,
      setControlPresence,
      resetPresence,
    ],
  );
}
