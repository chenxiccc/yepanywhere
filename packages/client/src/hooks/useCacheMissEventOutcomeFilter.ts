import { useSyncExternalStore } from "react";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

export const CACHE_MISS_EVENT_OUTCOME_FILTERS = [
  "misses",
  "hits",
  "all",
] as const;
export type CacheMissEventOutcomeFilter =
  (typeof CACHE_MISS_EVENT_OUTCOME_FILTERS)[number];

export const DEFAULT_CACHE_MISS_EVENT_OUTCOME_FILTER: CacheMissEventOutcomeFilter =
  "misses";

function parseCacheMissEventOutcomeFilter(
  raw: string,
): CacheMissEventOutcomeFilter | undefined {
  return (CACHE_MISS_EVENT_OUTCOME_FILTERS as readonly string[]).includes(raw)
    ? (raw as CacheMissEventOutcomeFilter)
    : undefined;
}

const store = createLocalStorageValue(
  UI_KEYS.cacheMissEventOutcomeFilter,
  DEFAULT_CACHE_MISS_EVENT_OUTCOME_FILTER,
  parseCacheMissEventOutcomeFilter,
);

export const setCacheMissEventOutcomeFilterPreference = store.set;
export const resetCacheMissEventOutcomeFilterPreference = store.reset;

export function useCacheMissEventOutcomeFilter() {
  const outcomeFilter = useSyncExternalStore(
    store.subscribe,
    store.read,
    () => DEFAULT_CACHE_MISS_EVENT_OUTCOME_FILTER,
  );
  return {
    outcomeFilter,
    setOutcomeFilter: store.set,
  };
}
