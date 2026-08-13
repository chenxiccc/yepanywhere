import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const quoteStore = createLocalStorageBoolean(
  UI_KEYS.selectionQuoteActionEnabled,
  true,
);
const textCopyStore = createLocalStorageBoolean(
  UI_KEYS.selectionTextCopyActionEnabled,
  false,
);
const sourceCopyStore = createLocalStorageBoolean(
  UI_KEYS.selectionSourceCopyActionEnabled,
  false,
);
const richCopyStore = createLocalStorageBoolean(
  UI_KEYS.selectionRichCopyActionEnabled,
  false,
);
const newSessionStore = createLocalStorageBoolean(
  UI_KEYS.selectionNewSessionActionEnabled,
  false,
);

export function useSelectionActionPreferences() {
  const selectionQuoteActionEnabled = useSyncExternalStore(
    quoteStore.subscribe,
    quoteStore.read,
    quoteStore.read,
  );
  const selectionTextCopyActionEnabled = useSyncExternalStore(
    textCopyStore.subscribe,
    textCopyStore.read,
    textCopyStore.read,
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
  const selectionNewSessionActionEnabled = useSyncExternalStore(
    newSessionStore.subscribe,
    newSessionStore.read,
    newSessionStore.read,
  );

  return {
    selectionQuoteActionEnabled,
    setSelectionQuoteActionEnabled: quoteStore.set,
    selectionTextCopyActionEnabled,
    setSelectionTextCopyActionEnabled: textCopyStore.set,
    selectionSourceCopyActionEnabled,
    setSelectionSourceCopyActionEnabled: sourceCopyStore.set,
    selectionRichCopyActionEnabled,
    setSelectionRichCopyActionEnabled: richCopyStore.set,
    selectionNewSessionActionEnabled,
    setSelectionNewSessionActionEnabled: newSessionStore.set,
  };
}
