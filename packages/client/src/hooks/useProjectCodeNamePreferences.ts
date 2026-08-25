import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

export interface ProjectCodeNamePreferences {
  enabled: boolean;
  activityPulseEnabled: boolean;
}

export const DEFAULT_PROJECT_CODE_NAME_PREFERENCES: ProjectCodeNamePreferences =
  {
    enabled: false,
    activityPulseEnabled: false,
  };

const enabledStore = createLocalStorageBoolean(
  UI_KEYS.projectCodeNamesEnabled,
  DEFAULT_PROJECT_CODE_NAME_PREFERENCES.enabled,
);
const activityPulseStore = createLocalStorageBoolean(
  UI_KEYS.projectCodeNameActivityPulseEnabled,
  DEFAULT_PROJECT_CODE_NAME_PREFERENCES.activityPulseEnabled,
);

export function getProjectCodeNamePreferences(): ProjectCodeNamePreferences {
  return {
    enabled: enabledStore.read(),
    activityPulseEnabled: activityPulseStore.read(),
  };
}

export function useProjectCodeNamePreferences() {
  const projectCodeNamesEnabled = useSyncExternalStore(
    enabledStore.subscribe,
    enabledStore.read,
    enabledStore.read,
  );
  const projectCodeNameActivityPulseEnabled = useSyncExternalStore(
    activityPulseStore.subscribe,
    activityPulseStore.read,
    activityPulseStore.read,
  );

  return {
    projectCodeNamesEnabled,
    setProjectCodeNamesEnabled: enabledStore.set,
    projectCodeNameActivityPulseEnabled,
    setProjectCodeNameActivityPulseEnabled: activityPulseStore.set,
  };
}
