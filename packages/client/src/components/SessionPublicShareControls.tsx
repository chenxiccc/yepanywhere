import type { PublicShareStorageState } from "@yep-anywhere/shared";
import type { MouseEvent } from "react";
import { usePublicSessionShareStatus } from "../hooks/usePublicSessionShareStatus";
import type { TranslationFn } from "../i18n";
import { SessionShareModal } from "./SessionShareModal";
import type { ModalAnchorRect } from "./ui/Modal";
import { ViewerCountIndicator } from "./ViewerCountIndicator";
import styles from "./SessionPublicShareControls.module.css";

interface SessionPublicShareControlsProps {
  enabled: boolean;
  projectId: string;
  sessionId: string;
  storageState: PublicShareStorageState | undefined;
  canCreateShares: boolean;
  managementAvailable: boolean;
  modalOpen: boolean;
  modalAnchorRect: ModalAnchorRect | null;
  modalInitialView: "manage" | "session";
  initialPrompt: string | null;
  title: string;
  onIndicatorClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onIndicatorContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onCloseModal: () => void;
  t: TranslationFn;
}

/**
 * Owns live public-share polling below the session-page render boundary.
 * Viewer heartbeat changes update the header control without reconciling the
 * transcript and the rest of SessionPageContent.
 */
export function SessionPublicShareControls({
  enabled,
  projectId,
  sessionId,
  storageState,
  canCreateShares,
  managementAvailable,
  modalOpen,
  modalAnchorRect,
  modalInitialView,
  initialPrompt,
  title,
  onIndicatorClick,
  onIndicatorContextMenu,
  onCloseModal,
  t,
}: SessionPublicShareControlsProps) {
  const { status, updateStatus } = usePublicSessionShareStatus({
    enabled,
    projectId,
    sessionId,
    storageState,
  });
  const showIndicator =
    canCreateShares ||
    (status?.activeCount ?? 0) > 0 ||
    (managementAvailable && enabled);

  return (
    <>
      {showIndicator && (
        <ViewerCountIndicator
          className={styles.viewerCount}
          count={
            status && status.liveCount > 0 ? status.activeViewerCount : null
          }
          label={
            status
              ? t("sessionShareViewerSummary", {
                  active: status.activeViewerCount,
                  total: status.viewers.length,
                  live: status.liveCount,
                  frozen: status.frozenCount,
                })
              : t("sessionShareOpenTitle")
          }
          onClick={onIndicatorClick}
          onContextMenu={onIndicatorContextMenu}
        />
      )}
      {modalOpen && (
        <SessionShareModal
          anchorRect={modalAnchorRect}
          projectId={projectId}
          sessionId={sessionId}
          initialPrompt={initialPrompt}
          title={title}
          canCreateShares={canCreateShares}
          initialView={modalInitialView}
          managementAvailable={managementAvailable}
          onStatusChange={updateStatus}
          onClose={onCloseModal}
        />
      )}
    </>
  );
}
