import { useSyncExternalStore } from "react";

export interface FileViewerControllerState {
  close: () => void;
  filePath: string;
  id: string;
  lineSuffix: string;
  minimize: () => void;
  minimized: boolean;
  restore: () => void;
}

let current: FileViewerControllerState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setFileViewerController(
  viewer: FileViewerControllerState,
): void {
  const previous = current;
  current = viewer;
  emit();
  if (previous && previous.id !== viewer.id) previous.restore();
}

export function clearFileViewerController(id: string): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): FileViewerControllerState | null {
  return current;
}

export function useFileViewerController(): FileViewerControllerState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
