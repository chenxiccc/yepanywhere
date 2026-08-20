import { createContext, type ReactNode, useContext } from "react";
import type { CommentAnchor } from "../lib/commentAnchors";

type QuoteTextBlock = (anchor: CommentAnchor) => void;

const QuoteReplyContext = createContext<QuoteTextBlock | null>(null);

export function QuoteReplyProvider({
  children,
  onQuoteTextBlock,
}: {
  children: ReactNode;
  onQuoteTextBlock: QuoteTextBlock;
}) {
  return (
    <QuoteReplyContext.Provider value={onQuoteTextBlock}>
      {children}
    </QuoteReplyContext.Provider>
  );
}

export function useQuoteReply(): QuoteTextBlock | null {
  return useContext(QuoteReplyContext);
}
