import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  clearSessionViewer,
  presentSessionViewer,
  useSessionViewerController,
} from "../lib/sessionViewerController";
import { Modal } from "./ui/Modal";

interface SessionManagedPanelProps {
  viewerId?: string;
  sessionId: string;
  title: ReactNode;
  actions?: ReactNode;
  label: string;
  briefLabel?: string;
  children: ReactNode;
  onClose: () => void;
}

const SessionViewerContext = createContext<string | null>(null);

export function useSessionViewerSessionId(): string | null {
  return useContext(SessionViewerContext);
}

/** Publishes a content panel to the session's shared managed-viewer host. */
export function SessionManagedPanel({
  viewerId: suppliedViewerId,
  sessionId,
  title,
  actions,
  label,
  briefLabel,
  children,
  onClose,
}: SessionManagedPanelProps) {
  const generatedViewerId = useId();
  const viewerId = suppliedViewerId ?? generatedViewerId;
  const mountedRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    presentSessionViewer({
      id: viewerId,
      kind: "panel",
      sessionId,
      title,
      actions,
      label,
      briefLabel,
      content: children,
      onClose: () => {
        if (mountedRef.current) onCloseRef.current();
      },
    });
  }, [actions, briefLabel, children, label, sessionId, title, viewerId]);

  return null;
}

export function SessionViewerProvider({
  sessionId,
  inactive = false,
  children,
}: {
  sessionId: string;
  inactive?: boolean;
  children: ReactNode;
}) {
  return (
    <SessionViewerContext.Provider value={sessionId}>
      {children}
      <SessionManagedPanelHost sessionId={sessionId} inactive={inactive} />
    </SessionViewerContext.Provider>
  );
}

export function SessionManagedPanelHost({
  sessionId,
  inactive = false,
}: {
  sessionId: string;
  inactive?: boolean;
}) {
  const controller = useSessionViewerController();
  const controllerRef = useRef(controller);
  const lifecycleGenerationRef = useRef(0);
  controllerRef.current = controller;
  const panel =
    controller?.kind === "panel" && controller.sessionId === sessionId
      ? controller
      : null;

  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    return () => {
      const cleanupGeneration = lifecycleGenerationRef.current + 1;
      lifecycleGenerationRef.current = cleanupGeneration;
      queueMicrotask(() => {
        const active = controllerRef.current;
        if (
          lifecycleGenerationRef.current === cleanupGeneration &&
          active?.sessionId === sessionId
        ) {
          clearSessionViewer(active.id);
        }
      });
    };
  }, [sessionId]);

  if (!panel) return null;
  return (
    <Modal
      title={panel.title}
      actions={panel.actions}
      onClose={panel.close}
      onMinimize={panel.minimize}
      minimized={panel.minimized || inactive}
    >
      {panel.content}
    </Modal>
  );
}
