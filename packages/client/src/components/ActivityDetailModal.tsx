import { type ReactNode, useRef } from "react";
import {
  SessionManagedPanel,
  useSessionViewerSessionId,
} from "./SessionManagedViewer";
import { Modal } from "./ui/Modal";
import { ViewerSelectAllButton } from "./ViewerSelectAllButton";

interface ActivityDetailModalProps {
  title: ReactNode;
  actions?: ReactNode;
  label: string;
  briefLabel?: string;
  children: ReactNode;
  onClose: () => void;
}

/**
 * Publishes an activity detail view to the stable session-level host. Outside
 * the explicit session-viewer provider it remains a plain close-only modal.
 */
export function ActivityDetailModal({
  title,
  actions,
  label,
  briefLabel,
  children,
  onClose,
}: ActivityDetailModalProps) {
  const sessionId = useSessionViewerSessionId();
  const contentRef = useRef<HTMLDivElement>(null);
  const headerActions = (
    <>
      {actions}
      <ViewerSelectAllButton
        className="source-detail-action source-detail-icon-action"
        contentRef={contentRef}
      />
    </>
  );

  if (!sessionId) {
    return (
      <Modal
        title={title}
        actions={headerActions}
        contentRef={contentRef}
        onClose={onClose}
      >
        {children}
      </Modal>
    );
  }

  return (
    <SessionManagedPanel
      sessionId={sessionId}
      title={title}
      actions={headerActions}
      contentRef={contentRef}
      label={label}
      briefLabel={briefLabel}
      onClose={onClose}
    >
      {children}
    </SessionManagedPanel>
  );
}
