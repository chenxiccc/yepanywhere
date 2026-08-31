import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(UI_KEYS.recentProjectPathLinks, false);

export const getRecentProjectPathLinksPreference = store.read;
export const setRecentProjectPathLinksPreference = store.set;
export const subscribeRecentProjectPathLinksPreference = store.subscribe;

export function useRecentProjectPathLinks() {
  const recentProjectPathLinksEnabled = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    recentProjectPathLinksEnabled,
    setRecentProjectPathLinksEnabled: store.set,
  };
}
