import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(UI_KEYS.conversationView, false);

export const getConversationViewPreference = store.read;
export const setConversationViewPreference = store.set;
export const subscribeConversationViewPreference = store.subscribe;

export function useConversationView() {
  const conversationViewEnabled = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    conversationViewEnabled,
    setConversationViewEnabled: store.set,
  };
}
