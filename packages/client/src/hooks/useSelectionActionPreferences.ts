import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const quoteStore = createLocalStorageBoolean(
  UI_KEYS.selectionQuoteActionEnabled,
  true,
);
const sourceCopyStore = createLocalStorageBoolean(
  UI_KEYS.selectionSourceCopyActionEnabled,
  false,
);
const richCopyStore = createLocalStorageBoolean(
  UI_KEYS.selectionRichCopyActionEnabled,
  false,
);

export function useSelectionActionPreferences() {
  const selectionQuoteActionEnabled = useSyncExternalStore(
    quoteStore.subscribe,
    quoteStore.read,
    quoteStore.read,
  );
  const selectionSourceCopyActionEnabled = useSyncExternalStore(
    sourceCopyStore.subscribe,
    sourceCopyStore.read,
    sourceCopyStore.read,
  );
  const selectionRichCopyActionEnabled = useSyncExternalStore(
    richCopyStore.subscribe,
    richCopyStore.read,
    richCopyStore.read,
  );

  return {
    selectionQuoteActionEnabled,
    setSelectionQuoteActionEnabled: quoteStore.set,
    selectionSourceCopyActionEnabled,
    setSelectionSourceCopyActionEnabled: sourceCopyStore.set,
    selectionRichCopyActionEnabled,
    setSelectionRichCopyActionEnabled: richCopyStore.set,
  };
}
