import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(
  UI_KEYS.keepMobileKeyboardOpenAfterDelivery,
  false,
);

/** Browser-local preference for restoring mobile composer focus after delivery. */
export function useKeepMobileKeyboardOpenAfterDelivery() {
  const keepMobileKeyboardOpenAfterDelivery = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return {
    keepMobileKeyboardOpenAfterDelivery,
    setKeepMobileKeyboardOpenAfterDelivery: store.set,
  };
}
