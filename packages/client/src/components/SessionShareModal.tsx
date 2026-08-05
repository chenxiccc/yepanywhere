import type {
  PublicShareLinkedFileMode,
  PublicShareManagementItem,
  PublicSessionShareMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { writeClipboardTextLater } from "../lib/clipboard";
import { Modal, type ModalAnchorRect } from "./ui/Modal";
import { ViewerCountIndicator } from "./ViewerCountIndicator";
import styles from "./SessionShareModal.module.css";

interface SessionShareModalProps {
  anchorRect?: ModalAnchorRect | null;
  initialPrompt?: string | null;
  projectId?: string;
  sessionId?: string;
  title?: string | null;
  canCreateShares?: boolean;
  onStatusChange?: (status: PublicSessionShareSessionStatusResponse) => void;
  onClose: () => void;
  initialView?: "manage" | "session";
  managementAvailable?: boolean;
}

type ShareWorkingState =
  | PublicSessionShareMode
  | "freeze-all"
  | "revoke"
  | `disconnect:${string}`
  | `freeze:${string}`;

function formatShareBytes(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function SessionShareModal({
  anchorRect,
  initialPrompt,
  projectId,
  sessionId,
  title,
  canCreateShares = true,
  onStatusChange,
  onClose,
  initialView = "session",
  managementAvailable = false,
}: SessionShareModalProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] =
    useState<PublicSessionShareSessionStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState<ShareWorkingState | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [view, setView] = useState(initialView);
  const [createdLinkedFileMode, setCreatedLinkedFileMode] =
    useState<PublicShareLinkedFileMode | null>(null);
  const [managementItems, setManagementItems] = useState<
    PublicShareManagementItem[]
  >([]);
  const [managementCursor, setManagementCursor] = useState<string | null>(null);
  const [managementTotal, setManagementTotal] = useState(0);
  const [managementScope, setManagementScope] = useState<
    "all" | "project" | "session"
  >(projectId && sessionId ? "session" : "all");
  const [showFrozenShares, setShowFrozenShares] = useState(true);
  const [showLiveShares, setShowLiveShares] = useState(true);
  const [managementLoading, setManagementLoading] = useState(false);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [managementWorking, setManagementWorking] = useState<string | null>(
    null,
  );
  const [managementRefresh, setManagementRefresh] = useState(0);
  const managementRefreshRef = useRef(managementRefresh);
  managementRefreshRef.current = managementRefresh;
  const [highlightedShareId, setHighlightedShareId] = useState<string | null>(
    null,
  );
  const [managementNotice, setManagementNotice] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const managementMode =
    showFrozenShares && showLiveShares
      ? undefined
      : showFrozenShares
        ? ("frozen" as const)
        : showLiveShares
          ? ("live" as const)
          : null;

  useEffect(() => {
    if (status) {
      onStatusChange?.(status);
    }
  }, [onStatusChange, status]);

  useEffect(() => {
    if (!projectId || !sessionId || view !== "session") return undefined;
    let cancelled = false;

    const refreshStatus = async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const nextStatus = await api.getPublicSessionShareStatus(
          projectId,
          sessionId,
        );
        if (!cancelled) {
          setStatus(nextStatus);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus(null);
          setStatusError(
            loadError instanceof Error
              ? loadError.message
              : t("publicShareManagementLoadFailed"),
          );
        }
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };

    void refreshStatus();

    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, t, view]);

  useEffect(() => {
    if (view !== "manage" || !managementAvailable) return undefined;
    if (managementMode === null) {
      setManagementItems([]);
      setManagementCursor(null);
      setManagementTotal(0);
      setManagementLoading(false);
      setManagementError(null);
      return undefined;
    }
    let cancelled = false;
    const refreshGeneration = managementRefresh;
    const load = async () => {
      setManagementLoading(true);
      setManagementError(null);
      try {
        const response = await api.getPublicShares({
          projectId: managementScope === "all" ? undefined : projectId,
          sessionId: managementScope === "session" ? sessionId : undefined,
          mode: managementMode,
        });
        if (
          cancelled ||
          refreshGeneration !== managementRefreshRef.current
        ) {
          return;
        }
        setManagementItems(response.items);
        setManagementCursor(response.nextCursor);
        setManagementTotal(response.totalCount);
      } catch (loadError) {
        if (!cancelled) {
          setManagementError(
            loadError instanceof Error
              ? loadError.message
              : t("publicShareManagementLoadFailed"),
          );
        }
      } finally {
        if (!cancelled) setManagementLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    managementAvailable,
    managementScope,
    projectId,
    sessionId,
    managementMode,
    managementRefresh,
    t,
    view,
  ]);

  const createAndCopyShare = async (mode: PublicSessionShareMode) => {
    if (!projectId || !sessionId) return;
    setIsWorking(mode);
    setError(null);
    setResult(null);
    // Kick off the create and the clipboard write together, synchronously within
    // this click, so the browser captures the user-activation now. Awaiting the
    // create first (relay hop, large frozen snapshot) can outlive the activation
    // window and the copy then fails as a permission error.
    const sharePromise = api.createPublicSessionShare({
      projectId: projectId as UrlProjectId,
      sessionId,
      mode,
      initialPrompt: initialPrompt ?? undefined,
      title: title ?? undefined,
    });
    const copyPromise = writeClipboardTextLater(
      sharePromise.then((created) => created.url),
    );
    try {
      const result = await sharePromise;
      setUrl(result.url);
      setHighlightedShareId(result.shareId ?? null);
      setCreatedLinkedFileMode(result.linkedFileMode ?? null);
      if (await copyPromise) {
        setResult(t("sessionShareCopiedReadOnly"));
      } else {
        window.setTimeout(() => {
          urlInputRef.current?.focus();
          urlInputRef.current?.select();
        }, 0);
        setResult(t("sessionShareManualCopy"));
      }
      setStatus((current) => {
        const frozenDelta = mode === "frozen" ? 1 : 0;
        const liveDelta = mode === "live" ? 1 : 0;
        const nextStatus = {
          activeCount: (current?.activeCount ?? 0) + 1,
          frozenCount: (current?.frozenCount ?? 0) + frozenDelta,
          liveCount: (current?.liveCount ?? 0) + liveDelta,
          activeViewerCount: current?.activeViewerCount ?? 0,
          viewers: current?.viewers ?? [],
        };
        return nextStatus;
      });
      setManagementRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sessionShareFailed"));
    } finally {
      setIsWorking(null);
    }
  };

  const revokeAll = async () => {
    if (!projectId || !sessionId) return;
    setIsWorking("revoke");
    setError(null);
    setResult(null);
    try {
      const response = await api.revokePublicSessionShares(
        projectId,
        sessionId,
      );
      setStatus(response);
      setUrl(null);
      setResult(t("sessionShareRevoked", { count: response.revokedCount }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionShareRevokeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const freezeAllLive = async () => {
    if (!projectId || !sessionId) return;
    setIsWorking("freeze-all");
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionLiveShares(
        projectId,
        sessionId,
      );
      setStatus(response);
      setResult(
        t("sessionShareFrozenLiveLinks", {
          count: response.convertedCount,
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionShareFreezeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const freezeViewerToken = async (viewer: PublicSessionShareViewerSummary) => {
    if (!projectId || !sessionId) return;
    setIsWorking(`freeze:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.freezePublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      setResult(t("sessionShareViewerFrozen", { token: viewer.shortId }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionShareFreezeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const disconnectViewerToken = async (
    viewer: PublicSessionShareViewerSummary,
  ) => {
    if (!projectId || !sessionId) return;
    setIsWorking(`disconnect:${viewer.viewerId}`);
    setError(null);
    setResult(null);
    try {
      const response = await api.disconnectPublicSessionViewerToken(
        projectId,
        sessionId,
        viewer.viewerId,
      );
      setStatus(response);
      setResult(t("sessionShareViewerDisconnected", { token: viewer.shortId }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionShareRevokeFailed"),
      );
    } finally {
      setIsWorking(null);
    }
  };

  const revokeManagedShare = async (item: PublicShareManagementItem) => {
    if (!window.confirm(t("publicShareManagementRevokeOneConfirm"))) return;
    setManagementWorking(item.shareId);
    setManagementError(null);
    try {
      const response = await api.revokePublicShare(item.shareId);
      if (response.revoked) {
        setManagementItems((items) =>
          items.filter((candidate) => candidate.shareId !== item.shareId),
        );
        setManagementTotal((count) => Math.max(0, count - 1));
      }
    } catch (revokeError) {
      setManagementError(
        revokeError instanceof Error
          ? revokeError.message
          : t("sessionShareRevokeFailed"),
      );
    } finally {
      setManagementWorking(null);
    }
  };

  const copyManagedShare = async (item: PublicShareManagementItem) => {
    if (!item.url) return;
    setManagementNotice(null);
    const copied = await writeClipboardTextLater(Promise.resolve(item.url));
    setHighlightedShareId(item.shareId);
    setManagementNotice(
      copied
        ? t("publicShareManagementCopied")
        : t("sessionShareManualCopy"),
    );
  };

  const createManagedShare = (mode: PublicSessionShareMode) => {
    if (mode === "frozen") {
      setShowFrozenShares(true);
    } else {
      setShowLiveShares(true);
    }
    void createAndCopyShare(mode);
  };

  const revokeEveryManagedShare = async () => {
    if (
      !window.confirm(
        managementScope === "session"
          ? t("publicShareManagementRevokeSessionConfirm")
          : managementScope === "project"
            ? t("publicShareManagementRevokeProjectConfirm")
            : t("publicShareManagementRevokeAllConfirm"),
      )
    ) {
      return;
    }
    setManagementWorking("all");
    setManagementError(null);
    try {
      if (managementScope === "session" && projectId && sessionId) {
        const response = await api.revokePublicSessionShares(
          projectId,
          sessionId,
        );
        setStatus(response);
      } else if (managementScope === "project" && projectId) {
        const shareIds: string[] = [];
        let cursor: string | undefined;
        do {
          const response = await api.getPublicShares({ projectId, cursor });
          shareIds.push(...response.items.map((item) => item.shareId));
          cursor = response.nextCursor ?? undefined;
        } while (cursor);
        for (const shareId of shareIds) {
          await api.revokePublicShare(shareId);
        }
      } else {
        await api.revokeAllPublicShares();
      }
      setManagementItems([]);
      setManagementCursor(null);
      setManagementTotal(0);
    } catch (revokeError) {
      setManagementError(
        revokeError instanceof Error
          ? revokeError.message
          : t("sessionShareRevokeFailed"),
      );
    } finally {
      setManagementWorking(null);
    }
  };

  const loadMoreManagedShares = async () => {
    if (!managementCursor) return;
    if (managementMode === null) return;
    setManagementLoading(true);
    setManagementError(null);
    try {
      const response = await api.getPublicShares({
        cursor: managementCursor,
        projectId: managementScope === "all" ? undefined : projectId,
        sessionId: managementScope === "session" ? sessionId : undefined,
        mode: managementMode,
      });
      setManagementItems((items) => [...items, ...response.items]);
      setManagementCursor(response.nextCursor);
      setManagementTotal(response.totalCount);
    } catch (loadError) {
      setManagementError(
        loadError instanceof Error
          ? loadError.message
          : t("publicShareManagementLoadFailed"),
      );
    } finally {
      setManagementLoading(false);
    }
  };

  const hasActiveShares = (status?.activeCount ?? 0) > 0;
  const activeViewerCount = status?.activeViewerCount ?? 0;
  const viewers = status?.viewers ?? [];
  const viewerSummary = t("sessionShareViewerSummary", {
    active: activeViewerCount,
    total: viewers.length,
    live: status?.liveCount ?? 0,
    frozen: status?.frozenCount ?? 0,
  });

  if (view === "manage") {
    return (
      <Modal
        anchorRect={anchorRect}
        anchorAtAnyWidth
        title={t("publicShareManagementTitle")}
        onClose={onClose}
      >
        <div className={`session-share-modal ${styles.manager}`}>
          <div className={styles.managerLayout}>
            <aside className={styles.managerSidebar}>
              {projectId && sessionId && (
                <div
                  className={styles.filterGroup}
                  role="group"
                  aria-label={t("publicShareManagementScopeFilter")}
                >
                  <span>{t("publicShareManagementScopeFilter")}</span>
                  {(["all", "project", "session"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      className={`${styles.filterButton} ${
                        managementScope === scope
                          ? styles.filterButtonActive
                          : ""
                      }`}
                      aria-pressed={managementScope === scope}
                      disabled={managementWorking !== null}
                      onClick={() => setManagementScope(scope)}
                    >
                      <span className={styles.filterIcon}>
                        <ShareFilterIcon kind={scope} />
                      </span>
                      <span>
                        {scope === "all"
                          ? t("publicShareManagementScopeAll")
                          : scope === "project"
                            ? t("publicShareManagementScopeProject")
                            : t("publicShareManagementScopeSession")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div
                className={styles.filterGroup}
                role="group"
                aria-label={t("publicShareManagementModeFilter")}
              >
                <span>{t("publicShareManagementModeFilter")}</span>
                {(["frozen", "live"] as const).map((mode) => {
                  const selected =
                    mode === "frozen" ? showFrozenShares : showLiveShares;
                  return (
                    <div className={styles.filterRow} key={mode}>
                      <button
                        type="button"
                        className={`${styles.filterButton} ${
                          selected ? styles.filterButtonActive : ""
                        }`}
                        aria-pressed={selected}
                        disabled={managementWorking !== null}
                        onClick={() =>
                          mode === "frozen"
                            ? setShowFrozenShares((value) => !value)
                            : setShowLiveShares((value) => !value)
                        }
                      >
                        <span className={styles.filterIcon}>
                          <ShareFilterIcon kind={mode} />
                        </span>
                        <span>
                          {mode === "live"
                            ? t("publicShareLiveBadge")
                            : t("publicShareManagementModeReadOnly")}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.addButton}
                        disabled={isWorking !== null || !canCreateShares}
                        onClick={() => createManagedShare(mode)}
                        title={t("publicShareManagementCreate", {
                          type:
                            mode === "live"
                              ? t("publicShareLiveBadge")
                              : t("publicShareManagementModeReadOnly"),
                        })}
                        aria-label={t("publicShareManagementCreate", {
                          type:
                            mode === "live"
                              ? t("publicShareLiveBadge")
                              : t("publicShareManagementModeReadOnly"),
                        })}
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
              {projectId && sessionId && (
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  onClick={() => setView("session")}
                >
                  {t("publicShareManagementBackToSession")}
                </button>
              )}
              <button
                type="button"
                className="settings-button settings-button-danger"
                disabled={managementWorking !== null}
                onClick={() => void revokeEveryManagedShare()}
              >
                {managementWorking === "all"
                  ? t("sessionShareRevoking")
                  : managementScope === "session"
                    ? t("sessionShareRevokeAll")
                    : managementScope === "project"
                      ? t("publicShareManagementRevokeProject")
                      : t("publicShareManagementRevokeAll")}
              </button>
            </aside>

            <div className={styles.managerMain}>
              {managementError && (
                <div className={styles.error} role="alert">
                  {managementError}
                </div>
              )}
              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}
              {(result || managementNotice) && (
                <div className={styles.notice} role="status">
                  {managementNotice ?? result}
                </div>
              )}
              {managementLoading && managementItems.length === 0 ? (
                <div className={styles.empty} role="status">
                  {t("publicShareManagementLoading")}
                </div>
              ) : managementItems.length === 0 ? (
                <div className={styles.empty}>
                  {t("publicShareManagementEmpty")}
                </div>
              ) : (
                <div className={styles.list} role="list">
                  {managementItems.map((item) => {
                    const bytes = formatShareBytes(item.snapshotBytes);
                    return (
                      <div
                        className={`${styles.row} ${
                          highlightedShareId === item.shareId
                            ? styles.rowHighlighted
                            : ""
                        }`}
                        role="listitem"
                        key={item.shareId}
                      >
                        <div className={styles.rowMain}>
                          <strong>
                            {item.title ?? t("publicShareUntitled")}
                          </strong>
                          <span className={styles.rowMeta}>
                            {item.projectName ??
                              t("publicShareManagementUnknownProject")}
                            {" · "}
                            {item.mode === "live"
                              ? t("publicShareLiveBadge")
                              : t("publicShareFrozenBadge")}
                            {bytes ? ` · ${bytes}` : ""}
                          </span>
                          <span className={styles.rowMeta}>
                            {new Date(item.createdAt).toLocaleString()}
                            {` · ${t("publicShareActiveViewers", {
                              count: item.activeViewerCount,
                            })}`}
                          </span>
                          {item.mode === "frozen" &&
                            item.linkedFileMode === "live" && (
                              <span className={styles.warning}>
                                {t("publicShareFrozenLinkedFilesLiveWarning")}
                              </span>
                            )}
                        </div>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.iconButton}
                            disabled={!item.url}
                            onClick={() => void copyManagedShare(item)}
                            title={
                              item.url
                                ? t("publicShareManagementCopy")
                                : t("publicShareManagementCopyUnavailable")
                            }
                            aria-label={
                              item.url
                                ? t("publicShareManagementCopy")
                                : t("publicShareManagementCopyUnavailable")
                            }
                          >
                            <CopyIcon />
                          </button>
                          <button
                            type="button"
                            className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                            disabled={managementWorking !== null}
                            onClick={() => void revokeManagedShare(item)}
                            title={t("publicShareManagementRevokeOne")}
                            aria-label={t("publicShareManagementRevokeOne")}
                          >
                            {managementWorking === item.shareId ? "…" : "×"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {managementCursor && (
                <button
                  type="button"
                  className="settings-button settings-button-secondary"
                  disabled={managementLoading}
                  onClick={() => void loadMoreManagedShares()}
                >
                  {managementLoading
                    ? t("publicShareManagementLoading")
                    : t("publicShareManagementLoadMore")}
                </button>
              )}
              <div className={styles.count}>
                {t("publicShareManagementCount", { count: managementTotal })}
              </div>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      anchorRect={anchorRect}
      title={t("sessionShareTitle")}
      onClose={onClose}
    >
      <div className="session-share-modal">
        <p className="session-share-readonly-note">
          {t("sessionShareReadOnlyNote")}
        </p>
        {canCreateShares ? (
          <div className="session-share-actions">
            <button
              type="button"
              className="session-share-action"
              onClick={() => void createAndCopyShare("frozen")}
              disabled={isWorking !== null}
            >
              <span className="session-share-option-title">
                {isWorking === "frozen"
                  ? t("sessionShareCopying")
                  : t("sessionShareCopyFrozenReadOnly")}
              </span>
              <span className="session-share-option-description">
                {t("sessionShareFrozenDescription")}
              </span>
            </button>
            <button
              type="button"
              className="session-share-action"
              onClick={() => void createAndCopyShare("live")}
              disabled={isWorking !== null}
            >
              <span className="session-share-option-title">
                {isWorking === "live"
                  ? t("sessionShareCopying")
                  : t("sessionShareCopyLiveReadOnly")}
              </span>
              <span className="session-share-option-description">
                {t("sessionShareLiveDescription")}
              </span>
            </button>
          </div>
        ) : (
          <p className="session-share-readonly-note">
            {t("sessionShareDisabledInSettings")}
          </p>
        )}

        {url && (
          <label className="session-share-url-field">
            <span>{t("sessionShareUrlLabel")}</span>
            <input
              ref={urlInputRef}
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
        )}

        {error && <div className="session-share-error">{error}</div>}
        {result && <div className="session-share-status">{result}</div>}
        {createdLinkedFileMode === "live" && (
          <div className="session-share-error" role="note">
            {t("publicShareFrozenLinkedFilesLiveWarning")}
          </div>
        )}

        {statusLoading && (
          <div className="session-share-status" role="status">
            {t("publicShareManagementLoadingExisting")}
          </div>
        )}
        {statusError && (
          <div className="session-share-error" role="alert">
            {statusError}
          </div>
        )}
        {managementAvailable && (
          <button
            type="button"
            className="session-share-small-button"
            onClick={() => setView("manage")}
          >
            {t("publicShareManagementManageSession")}
          </button>
        )}

        {hasActiveShares && (
          <div className="session-share-management">
            <div className="session-share-management-header">
              <ViewerCountIndicator
                className="session-share-viewer-count"
                count={activeViewerCount}
                label={viewerSummary}
              />
              <div className="session-share-global-controls">
                <button
                  type="button"
                  className="session-share-small-button"
                  onClick={() => void freezeAllLive()}
                  disabled={
                    isWorking !== null || (status?.liveCount ?? 0) === 0
                  }
                  title={t("sessionShareFreezeLiveTitle")}
                >
                  {isWorking === "freeze-all"
                    ? t("sessionShareFreezing")
                    : t("sessionShareFreezeLive")}
                </button>
                <button
                  type="button"
                  className="session-share-revoke-button"
                  onClick={() => void revokeAll()}
                  disabled={isWorking !== null}
                  title={t("sessionShareRevokeAllTitle")}
                >
                  {isWorking === "revoke"
                    ? t("sessionShareRevoking")
                    : t("sessionShareRevokeAll")}
                </button>
              </div>
            </div>
            {viewers.length > 0 && (
              <>
                <p className="session-share-readonly-note">
                  {t("sessionShareViewerOperationalWarning")}
                </p>
                <div
                  className="session-share-viewer-list"
                  role="list"
                  aria-label={t("sessionShareViewerList")}
                >
                  {viewers.map((viewer) => (
                    <div
                      className="session-share-viewer-row"
                      key={viewer.viewerId}
                    >
                      <div className="session-share-viewer-main">
                        <span className="session-share-viewer-token">
                          {viewer.shortId}
                        </span>
                        <span className="session-share-viewer-meta">
                          {t("sessionShareViewerMeta", {
                            count: viewer.accessCount,
                            time: new Date(viewer.lastSeenAt).toLocaleString(),
                          })}
                        </span>
                      </div>
                      <div className="session-share-viewer-state">
                        {viewer.disconnected
                          ? t("sessionShareViewerDisconnectedState")
                          : viewer.frozen
                            ? t("sessionShareViewerFrozenState")
                            : viewer.active
                              ? t("sessionShareViewerActiveState")
                              : t("sessionShareViewerInactiveState")}
                      </div>
                      <div className="session-share-viewer-actions">
                        <button
                          type="button"
                          className="session-share-icon-button"
                          onClick={() => void freezeViewerToken(viewer)}
                          disabled={
                            isWorking !== null ||
                            viewer.disconnected ||
                            viewer.frozen ||
                            (status?.liveCount ?? 0) === 0
                          }
                          title={t("sessionShareFreezeViewerTitle", {
                            token: viewer.shortId,
                          })}
                          aria-label={t("sessionShareFreezeViewerTitle", {
                            token: viewer.shortId,
                          })}
                        >
                          |||
                        </button>
                        <button
                          type="button"
                          className="session-share-icon-button session-share-icon-button-danger"
                          onClick={() => void disconnectViewerToken(viewer)}
                          disabled={isWorking !== null || viewer.disconnected}
                          title={t("sessionShareDisconnectViewerTitle", {
                            token: viewer.shortId,
                          })}
                          aria-label={t("sessionShareDisconnectViewerTitle", {
                            token: viewer.shortId,
                          })}
                        >
                          x
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ShareFilterIcon({
  kind,
}: {
  kind: "all" | "project" | "session" | PublicSessionShareMode;
}) {
  const paths = {
    all: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
      </>
    ),
    project: (
      <path d="M3 6.5h7l2 2h9v10.5H3zM3 6.5V5h7l2 2" />
    ),
    session: (
      <>
        <rect x="3" y="4" width="18" height="14" rx="3" />
        <path d="m8 21 4-3h5M7 9h10M7 13h7" />
      </>
    ),
    frozen: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    live: (
      <>
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
        <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}
