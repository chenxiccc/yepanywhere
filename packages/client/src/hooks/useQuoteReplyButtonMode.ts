import { useSyncExternalStore } from "react";
import { createLocalStorageValue } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

export const QUOTE_REPLY_BUTTON_MODES = [
  "block",
  "paragraph-hover",
  "paragraph-always",
] as const;
export type QuoteReplyButtonMode = (typeof QUOTE_REPLY_BUTTON_MODES)[number];

const DEFAULT_QUOTE_REPLY_BUTTON_MODE: QuoteReplyButtonMode = "paragraph-hover";

function parseQuoteReplyButtonMode(
  raw: string,
): QuoteReplyButtonMode | undefined {
  return (QUOTE_REPLY_BUTTON_MODES as readonly string[]).includes(raw)
    ? (raw as QuoteReplyButtonMode)
    : undefined;
}

const store = createLocalStorageValue<QuoteReplyButtonMode>(
  UI_KEYS.quoteReplyButtonMode,
  DEFAULT_QUOTE_REPLY_BUTTON_MODE,
  parseQuoteReplyButtonMode,
);

export const setQuoteReplyButtonModePreference = store.set;

export function useQuoteReplyButtonMode() {
  const quoteReplyButtonMode = useSyncExternalStore(
    store.subscribe,
    store.read,
    () => DEFAULT_QUOTE_REPLY_BUTTON_MODE,
  );

  return {
    quoteReplyButtonMode,
    setQuoteReplyButtonMode: store.set,
  };
}

export const getQuoteReplyButtonMode = store.read;
