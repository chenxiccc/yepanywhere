import { useSyncExternalStore } from "react";
import {
  createLocalStorageBoolean,
  createLocalStorageValue,
} from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(UI_KEYS.conversationView, true);

export const DEFAULT_CONVERSATION_VIEW_TURN_LIMIT = 100;
export const MIN_CONVERSATION_VIEW_TURN_LIMIT = 10;
export const MAX_CONVERSATION_VIEW_TURN_LIMIT = 500;
export const CONVERSATION_VIEW_TURN_LIMIT_STEP = 10;

function normalizeTurnLimit(value: number): number {
  const finite = Number.isFinite(value)
    ? value
    : DEFAULT_CONVERSATION_VIEW_TURN_LIMIT;
  const stepped =
    MIN_CONVERSATION_VIEW_TURN_LIMIT +
    Math.round(
      (finite - MIN_CONVERSATION_VIEW_TURN_LIMIT) /
        CONVERSATION_VIEW_TURN_LIMIT_STEP,
    ) *
      CONVERSATION_VIEW_TURN_LIMIT_STEP;
  return Math.min(
    MAX_CONVERSATION_VIEW_TURN_LIMIT,
    Math.max(MIN_CONVERSATION_VIEW_TURN_LIMIT, stepped),
  );
}

const turnLimitStore = createLocalStorageValue(
  UI_KEYS.conversationViewTurnLimit,
  DEFAULT_CONVERSATION_VIEW_TURN_LIMIT,
  (raw) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? normalizeTurnLimit(parsed) : undefined;
  },
);

export const getConversationViewPreference = store.read;
export const setConversationViewPreference = store.set;
export const subscribeConversationViewPreference = store.subscribe;
export const getConversationViewTurnLimit = turnLimitStore.read;
export const subscribeConversationViewTurnLimit = turnLimitStore.subscribe;
export const setConversationViewTurnLimit = (value: number) => {
  turnLimitStore.set(normalizeTurnLimit(value));
};

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

export function useConversationViewTurnLimit() {
  const conversationViewTurnLimit = useSyncExternalStore(
    turnLimitStore.subscribe,
    turnLimitStore.read,
    turnLimitStore.read,
  );
  return {
    conversationViewTurnLimit,
    setConversationViewTurnLimit,
  };
}
