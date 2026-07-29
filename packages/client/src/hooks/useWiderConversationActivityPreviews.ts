import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(
  UI_KEYS.widerConversationActivityPreviews,
  false,
);

export function useWiderConversationActivityPreviews() {
  const widerConversationActivityPreviews = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    widerConversationActivityPreviews,
    setWiderConversationActivityPreviews: store.set,
  };
}
