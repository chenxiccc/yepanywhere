import {
  type SessionViewerControllerState,
  useSessionViewerController,
} from "./sessionViewerController";

export type FileViewerControllerState = Extract<
  SessionViewerControllerState,
  { kind: "file" }
>;

export function useFileViewerController(): FileViewerControllerState | null {
  const viewer = useSessionViewerController();
  return viewer?.kind === "file" ? viewer : null;
}
