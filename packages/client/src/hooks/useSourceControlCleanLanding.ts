import { useSyncExternalStore } from "react";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

export const SOURCE_CONTROL_CLEAN_LANDINGS = [
  "working-tree",
  "latest-commit",
] as const;
export type SourceControlCleanLanding =
  (typeof SOURCE_CONTROL_CLEAN_LANDINGS)[number];

export const DEFAULT_SOURCE_CONTROL_CLEAN_LANDING: SourceControlCleanLanding =
  "working-tree";

function parseSourceControlCleanLanding(
  raw: string,
): SourceControlCleanLanding | undefined {
  return (SOURCE_CONTROL_CLEAN_LANDINGS as readonly string[]).includes(raw)
    ? (raw as SourceControlCleanLanding)
    : undefined;
}

const store = createLocalStorageValue<SourceControlCleanLanding>(
  UI_KEYS.sourceControlCleanLanding,
  DEFAULT_SOURCE_CONTROL_CLEAN_LANDING,
  parseSourceControlCleanLanding,
);

export const getSourceControlCleanLanding = store.read;
export const setSourceControlCleanLandingPreference = store.set;

export function useSourceControlCleanLanding() {
  const sourceControlCleanLanding = useSyncExternalStore(
    store.subscribe,
    store.read,
    () => DEFAULT_SOURCE_CONTROL_CLEAN_LANDING,
  );
  return {
    sourceControlCleanLanding,
    setSourceControlCleanLanding: store.set,
  };
}
