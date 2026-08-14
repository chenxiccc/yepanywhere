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

interface ActivityDetailModalProps {
  title: ReactNode;
  label: string;
  briefLabel?: string;
  children: ReactNode;
  onClose: () => void;
}

const ActivityViewerSessionContext = createContext<string | null>(null);

/**
 * Publishes an activity detail view to the stable session-level host. Outside
 * the explicit session-viewer provider it remains a plain close-only modal.
 */
export function ActivityDetailModal({
  title,
  label,
  briefLabel,
  children,
  onClose,
}: ActivityDetailModalProps) {
  const sessionId = useContext(ActivityViewerSessionContext);
  const viewerId = useId();
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
    if (!sessionId) return;
    presentSessionViewer({
      id: viewerId,
      kind: "activity",
      sessionId,
      title,
      label,
      briefLabel,
      content: children,
      onClose: () => {
        if (mountedRef.current) onCloseRef.current();
      },
    });
  }, [briefLabel, children, label, sessionId, title, viewerId]);

  if (!sessionId) {
    return (
      <Modal title={title} onClose={onClose}>
        {children}
      </Modal>
    );
  }
  return null;
}

export function ActivityViewerProvider({
  sessionId,
  inactive = false,
  children,
}: {
  sessionId: string;
  inactive?: boolean;
  children: ReactNode;
}) {
  return (
    <ActivityViewerSessionContext.Provider value={sessionId}>
      {children}
      <ActivityViewerHost sessionId={sessionId} inactive={inactive} />
    </ActivityViewerSessionContext.Provider>
  );
}

export function ActivityViewerHost({
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
  const activity =
    controller?.kind === "activity" && controller.sessionId === sessionId
      ? controller
      : null;

  useEffect(() => {
    if (controller?.kind === "activity" && controller.sessionId !== sessionId) {
      clearSessionViewer(controller.id);
    }
  }, [controller, sessionId]);

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

  if (!activity) return null;
  return (
    <Modal
      title={activity.title}
      onClose={activity.close}
      onMinimize={activity.minimize}
      minimized={activity.minimized || inactive}
    >
      {activity.content}
    </Modal>
  );
}
