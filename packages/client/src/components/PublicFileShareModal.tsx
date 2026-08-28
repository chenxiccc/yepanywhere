import type {
  PublicFileShareManagementItem,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { writeClipboardText, writeClipboardTextLater } from "../lib/clipboard";
import { Modal, type ModalAnchorRect } from "./ui/Modal";
import styles from "./PublicFileShareModal.module.css";

interface PublicFileShareModalProps {
  anchorRect?: ModalAnchorRect | null;
  filePath: string;
  projectId: string;
  title?: string | null;
  onClose: () => void;
}

export function PublicFileShareModal({
  anchorRect,
  filePath,
  projectId,
  title,
  onClose,
}: PublicFileShareModalProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<PublicFileShareManagementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const manualUrlRef = useRef<HTMLInputElement>(null);

  const loadShares = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getPublicFileShares(
        projectId as UrlProjectId,
        filePath,
      );
      setItems(response.items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("publicFileShareLoadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [filePath, projectId, t]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  useEffect(() => {
    if (!manualUrl) return;
    manualUrlRef.current?.focus();
    manualUrlRef.current?.select();
  }, [manualUrl]);

  const createAndCopyShare = async () => {
    setWorking("create");
    setError(null);
    setNotice(null);
    setManualUrl(null);
    const request = api.createPublicFileShare({
      projectId: projectId as UrlProjectId,
      path: filePath,
      ...(title ? { title } : {}),
    });
    const copy = writeClipboardTextLater(
      request.then((created) => created.url),
    );
    try {
      const created = await request;
      if (await copy) {
        setNotice(t("publicFileShareCopied"));
      } else {
        setManualUrl(created.url);
        setNotice(t("publicFileShareManualCopy"));
      }
      await loadShares();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t("publicFileShareCreateFailed"),
      );
    } finally {
      setWorking(null);
    }
  };

  const copyShare = async (item: PublicFileShareManagementItem) => {
    setError(null);
    setNotice(null);
    setManualUrl(null);
    if (await writeClipboardText(item.url)) {
      setNotice(t("publicFileShareCopied"));
      return;
    }
    setManualUrl(item.url);
    setNotice(t("publicFileShareManualCopy"));
  };

  const revokeShare = async (item: PublicFileShareManagementItem) => {
    if (pendingRevoke !== item.shareId) {
      setPendingRevoke(item.shareId);
      setNotice(t("publicFileShareRevokeConfirm"));
      return;
    }
    setWorking(`revoke:${item.shareId}`);
    setError(null);
    setNotice(null);
    try {
      await api.revokePublicFileShare(item.shareId);
      setItems((current) =>
        current.filter((candidate) => candidate.shareId !== item.shareId),
      );
      setPendingRevoke(null);
      setNotice(t("publicFileShareRevoked"));
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : t("publicFileShareRevokeFailed"),
      );
    } finally {
      setWorking(null);
    }
  };

  return (
    <Modal
      anchorRect={anchorRect}
      title={t("publicFileShareTitle")}
      onClose={onClose}
    >
      <div className={styles.modal}>
        <div className={styles.fileIdentity} title={filePath}>
          <FileIcon />
          <span>{filePath}</span>
          <span className={styles.liveBadge}>{t("publicShareLiveBadge")}</span>
        </div>
        <p className={styles.description}>{t("publicFileShareDescription")}</p>
        <div className={styles.warning} role="note">
          <WarningIcon />
          <span>{t("publicFileShareWarning")}</span>
        </div>
        <button
          type="button"
          className={`settings-button settings-button-primary ${styles.createButton}`}
          disabled={working !== null}
          onClick={() => void createAndCopyShare()}
        >
          <LinkIcon />
          {working === "create"
            ? t("publicFileShareCreating")
            : t("publicFileShareCreate")}
        </button>

        {manualUrl && (
          <label className={styles.manualCopy}>
            <span>{t("publicFileShareUrlLabel")}</span>
            <input ref={manualUrlRef} readOnly value={manualUrl} />
          </label>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        )}

        <div className={styles.inventory}>
          <div className={styles.inventoryHeading}>
            <strong>{t("publicFileShareExisting")}</strong>
            {!loading && (
              <span>{t("publicFileShareCount", { count: items.length })}</span>
            )}
          </div>
          {loading ? (
            <div className={styles.empty}>{t("publicFileShareLoading")}</div>
          ) : items.length === 0 ? (
            <div className={styles.empty}>{t("publicFileShareEmpty")}</div>
          ) : (
            <div className={styles.list}>
              {items.map((item) => {
                const revoking = working === `revoke:${item.shareId}`;
                const confirming = pendingRevoke === item.shareId;
                return (
                  <div className={styles.row} key={item.shareId}>
                    <div className={styles.rowMain}>
                      <strong>
                        {item.title || filePath.split("/").at(-1)}
                      </strong>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        disabled={working !== null}
                        onClick={() => void copyShare(item)}
                        aria-label={t("publicFileShareCopy")}
                        title={t("publicFileShareCopy")}
                      >
                        <CopyIcon />
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconButton} ${
                          confirming ? styles.confirmRevoke : styles.revoke
                        }`}
                        disabled={working !== null}
                        onClick={() => void revokeShare(item)}
                        aria-label={
                          confirming
                            ? t("publicFileShareConfirmRevoke")
                            : t("publicFileShareRevoke")
                        }
                        title={
                          confirming
                            ? t("publicFileShareConfirmRevoke")
                            : t("publicFileShareRevoke")
                        }
                      >
                        {revoking ? (
                          "…"
                        ) : confirming ? (
                          <CheckIcon />
                        ) : (
                          <RevokeIcon />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M10 2.5 18 17H2zM10 7v4.5M10 14.5v.1" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="m8 12 4-4M6.5 14.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0M13.5 5.5l1-1a2.8 2.8 0 1 1 4 4l-3 3a2.8 2.8 0 0 1-4 0" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function RevokeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  );
}
