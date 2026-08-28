import type {
  PublicFileShareManagementItem,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { writeClipboardTextLater } from "../lib/clipboard";
import {
  PublicShareFeedback,
  PublicShareInventoryCount,
  PublicShareInventoryEmpty,
  PublicShareInventoryList,
  PublicShareInventoryMeta,
  PublicShareInventoryRow,
} from "./PublicShareInventory";
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
    if (await writeClipboardTextLater(Promise.resolve(item.url))) {
      setNotice(t("publicFileShareCopied"));
      return;
    }
    setManualUrl(item.url);
    setNotice(t("publicFileShareManualCopy"));
  };

  const revokeShare = async (item: PublicFileShareManagementItem) => {
    if (!window.confirm(t("publicShareManagementRevokeOneConfirm"))) return;
    setWorking(`revoke:${item.shareId}`);
    setError(null);
    setNotice(null);
    try {
      await api.revokePublicFileShare(item.shareId);
      setItems((current) =>
        current.filter((candidate) => candidate.shareId !== item.shareId),
      );
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
          <PublicShareFeedback tone="error">{error}</PublicShareFeedback>
        )}
        {notice && (
          <PublicShareFeedback tone="notice">{notice}</PublicShareFeedback>
        )}

        <div className={styles.inventory}>
          <div className={styles.inventoryHeading}>
            <strong>{t("publicFileShareExisting")}</strong>
          </div>
          {loading ? (
            <PublicShareInventoryEmpty loading>
              {t("publicFileShareLoading")}
            </PublicShareInventoryEmpty>
          ) : items.length === 0 ? (
            <PublicShareInventoryEmpty>
              {t("publicFileShareEmpty")}
            </PublicShareInventoryEmpty>
          ) : (
            <PublicShareInventoryList compact>
              {items.map((item) => {
                const revoking = working === `revoke:${item.shareId}`;
                return (
                  <PublicShareInventoryRow
                    key={item.shareId}
                    title={item.title || filePath.split("/").at(-1) || filePath}
                    mode="live"
                    modeLabel={t("publicShareLiveBadge")}
                    copyAction={{
                      label: t("publicFileShareCopy"),
                      disabled: working !== null,
                      onClick: () => void copyShare(item),
                    }}
                    revokeAction={{
                      label: t("publicFileShareRevoke"),
                      disabled: working !== null,
                      working: revoking,
                      onClick: () => void revokeShare(item),
                    }}
                  >
                    <PublicShareInventoryMeta>
                      {new Date(item.createdAt).toLocaleString()}
                    </PublicShareInventoryMeta>
                  </PublicShareInventoryRow>
                );
              })}
            </PublicShareInventoryList>
          )}
          {!loading && (
            <PublicShareInventoryCount>
              {t("publicFileShareCount", { count: items.length })}
            </PublicShareInventoryCount>
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
