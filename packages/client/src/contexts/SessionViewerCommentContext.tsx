import { createContext, type ReactNode, useContext } from "react";

export type SendSessionViewerComment = (text: string) => Promise<boolean>;

const SessionViewerCommentContext =
  createContext<SendSessionViewerComment | null>(null);

export function SessionViewerCommentProvider({
  children,
  onSendComment,
}: {
  children: ReactNode;
  onSendComment?: SendSessionViewerComment;
}) {
  return (
    <SessionViewerCommentContext.Provider value={onSendComment ?? null}>
      {children}
    </SessionViewerCommentContext.Provider>
  );
}

export function useSessionViewerComment(): SendSessionViewerComment | null {
  return useContext(SessionViewerCommentContext);
}
