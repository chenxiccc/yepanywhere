import { type RefObject, useEffect, useRef } from "react";
import {
  type MarkdownCopySourceContext,
  registerMarkdownCopySource,
} from "../lib/markdownSelectionCopy";

export function useRegisterQuoteableTextSource<T extends HTMLElement>(
  ref: RefObject<T | null>,
  source: string | null | undefined,
  context?: MarkdownCopySourceContext,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !source?.trim()) {
      return;
    }
    return registerMarkdownCopySource(element, source, context);
  }, [context, ref, source]);
}

export function useQuoteableTextSource<T extends HTMLElement>(
  source: string | null | undefined,
  context?: MarkdownCopySourceContext,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useRegisterQuoteableTextSource(ref, source, context);
  return ref;
}
