import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(UI_KEYS.glossaryHints, false);

export function useGlossaryHints() {
  const glossaryHintsEnabled = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    glossaryHintsEnabled,
    setGlossaryHintsEnabled: store.set,
  };
}
