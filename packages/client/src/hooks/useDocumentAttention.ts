import { useSyncExternalStore } from "react";

function documentIsAttentive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function subscribeDocumentAttention(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}

export function useDocumentAttention(): boolean {
  return useSyncExternalStore(
    subscribeDocumentAttention,
    documentIsAttentive,
    () => false,
  );
}
