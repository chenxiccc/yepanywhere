import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(
  UI_KEYS.inlineMediaExpandedByDefault,
  false,
);
const galleryStore = createLocalStorageBoolean(
  UI_KEYS.compactMultiImageGalleries,
  true,
);

export const setInlineMediaExpandedPreference = store.set;
export const setCompactMultiImageGalleriesPreference = galleryStore.set;

export function useInlineMedia() {
  const inlineMediaExpandedByDefault = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  const compactMultiImageGalleries = useSyncExternalStore(
    galleryStore.subscribe,
    galleryStore.read,
    galleryStore.read,
  );
  return {
    compactMultiImageGalleries,
    inlineMediaExpandedByDefault,
    setCompactMultiImageGalleries: galleryStore.set,
    setInlineMediaExpandedByDefault: store.set,
  };
}
