import type { DraftTextChangeMetadata } from "./commentAnchors";

export interface ComposerDraftChange {
  text: string;
  metadata: DraftTextChangeMetadata;
  hasTextContent: boolean;
}

export interface ComposerDraftSignal {
  getDraft(): string;
  publishDraftChange(text: string, metadata: DraftTextChangeMetadata): void;
  subscribeDraftChanges(
    listener: (change: ComposerDraftChange) => void,
  ): () => void;
}

export interface ComposerEditAvailabilityStore {
  getSnapshot(): boolean;
  getCurrent(): boolean;
  setDraftText(text: string): void;
  setExternalBlockers(hasAttachments: boolean, hasActiveUploads: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createComposerDraftSignal(): ComposerDraftSignal {
  let draft = "";
  const listeners = new Set<(change: ComposerDraftChange) => void>();

  return {
    getDraft: () => draft,
    publishDraftChange: (text, metadata) => {
      draft = text;
      const change = {
        text,
        metadata,
        hasTextContent: text.trim().length > 0,
      };
      for (const listener of listeners) {
        listener(change);
      }
    },
    subscribeDraftChanges: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createComposerEditAvailabilityStore(): ComposerEditAvailabilityStore {
  let hasDraftText = false;
  let hasAttachments = false;
  let hasActiveUploads = false;
  let snapshot = true;
  const listeners = new Set<() => void>();

  const updateSnapshot = (): void => {
    const next = !hasDraftText && !hasAttachments && !hasActiveUploads;
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    getCurrent: () => snapshot,
    setDraftText: (text) => {
      hasDraftText = text.trim().length > 0;
      updateSnapshot();
    },
    setExternalBlockers: (nextHasAttachments, nextHasActiveUploads) => {
      hasAttachments = nextHasAttachments;
      hasActiveUploads = nextHasActiveUploads;
      updateSnapshot();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
