import type {
  PublicShareManagementItem,
  PublicSessionShareMode,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { writeClipboardTextLater } from "../lib/clipboard";
import { Modal, type ModalAnchorRect } from "./ui/Modal";
import styles from "./SessionShareModal.module.css";

export interface PublicShareCreationIdentity {
  projectId: string;
  sessionId: string;
  title?: string | null;
  initialPrompt?: string | null;
}

interface PublicShareManagerModalProps {
  anchorRect?: ModalAnchorRect | null;
  creationIdentity?: PublicShareCreationIdentity;
  creationReady: boolean;
  selectiveFreezeAvailable?: boolean;
  onClose: () => void;
}

type PublicShareManagementScope = "all" | "project" | "session";

type InventoryFilter = {
  projectId?: string;
  sessionId?: string;
  mode?: PublicSessionShareMode;
};

type CategoryAction = "freeze" | "revoke";

interface CategoryActionTarget {
  action: CategoryAction;
  key: `scope:${PublicShareManagementScope}` | `mode:${PublicSessionShareMode}`;
  mode?: PublicSessionShareMode;
  scope: PublicShareManagementScope;
  scopeLabel: string;
  typeLabel?: string;
}

interface PendingCategoryAction extends CategoryActionTarget {
  generation: number;
  shareIds: readonly string[];
  viewerCount: number;
}

type PublicShareInventoryResponse = Awaited<
  ReturnType<typeof api.getPublicShares>
>;

interface PreparedInventoryRequest {
  generation: number;
  promise: Promise<PublicShareInventoryResponse>;
}

function formatShareBytes(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function PublicShareManagerModal(props: PublicShareManagerModalProps) {
  const sourceKey = useClientSummarySourceKey();
  const version = useRetainedVersionInfo(sourceKey);
  const selectiveFreezeAvailable =
    props.selectiveFreezeAvailable ??
    serverHasCapability(version, PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY);
  return (
    <SourcePublicShareManagerModal
      key={sourceKey}
      {...props}
      selectiveFreezeAvailable={selectiveFreezeAvailable}
    />
  );
}

function SourcePublicShareManagerModal({
  anchorRect,
  creationIdentity,
  creationReady,
  selectiveFreezeAvailable = false,
  onClose,
}: PublicShareManagerModalProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<PublicShareManagementItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState<PublicShareManagementScope>(
    creationIdentity ? "session" : "all",
  );
  const [showFrozenShares, setShowFrozenShares] = useState(true);
  const [showLiveShares, setShowLiveShares] = useState(true);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryGeneration, setInventoryGeneration] = useState(0);
  const inventoryGenerationRef = useRef(0);
  const inventoryRequestOwnerRef = useRef(0);
  const preparedInventoryRequestRef = useRef<PreparedInventoryRequest | null>(
    null,
  );
  const operationGenerationRef = useRef(0);
  const nonAbortableOperationGenerationRef = useRef<number | null>(null);
  const [operationWorking, setOperationWorking] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCategoryAction, setPendingCategoryAction] =
    useState<PendingCategoryAction | null>(null);
  const [highlightedShareId, setHighlightedShareId] = useState<string | null>(
    null,
  );

  useEffect(
    () => () => {
      inventoryGenerationRef.current += 1;
      inventoryRequestOwnerRef.current += 1;
      operationGenerationRef.current += 1;
      nonAbortableOperationGenerationRef.current = null;
      preparedInventoryRequestRef.current = null;
    },
    [],
  );

  const mode =
    showFrozenShares && showLiveShares
      ? undefined
      : showFrozenShares
        ? ("frozen" as const)
        : showLiveShares
          ? ("live" as const)
          : null;

  const creationProjectId = creationIdentity?.projectId;
  const creationSessionId = creationIdentity?.sessionId;
  const makeFilter = useCallback(
    (
      nextScope: PublicShareManagementScope,
      nextMode: PublicSessionShareMode | undefined,
    ): InventoryFilter => ({
      projectId: nextScope === "all" ? undefined : creationProjectId,
      sessionId: nextScope === "session" ? creationSessionId : undefined,
      mode: nextMode,
    }),
    [creationProjectId, creationSessionId],
  );

  const invalidateInventory = useCallback(() => {
    const generation = inventoryGenerationRef.current + 1;
    inventoryGenerationRef.current = generation;
    inventoryRequestOwnerRef.current += 1;
    setItems([]);
    setCursor(null);
    setTotal(0);
    setInventoryLoading(false);
    setInventoryError(null);
    setInventoryGeneration(generation);
    return generation;
  }, []);

  const cancelExclusiveOperation = useCallback(() => {
    if (nonAbortableOperationGenerationRef.current !== null) return false;
    operationGenerationRef.current += 1;
    setOperationWorking(null);
    setOperationError(null);
    setPendingCategoryAction(null);
    return true;
  }, []);

  const beginExclusiveOperation = useCallback(
    (working: string, nonAbortable = false) => {
      if (nonAbortableOperationGenerationRef.current !== null) return null;
      const generation = operationGenerationRef.current + 1;
      operationGenerationRef.current = generation;
      nonAbortableOperationGenerationRef.current = nonAbortable
        ? generation
        : null;
      setOperationWorking(working);
      setOperationError(null);
      setNotice(null);
      setPendingCategoryAction(null);
      return generation;
    },
    [],
  );

  const operationIsCurrent = useCallback(
    (generation: number) => operationGenerationRef.current === generation,
    [],
  );

  const finishExclusiveOperation = useCallback(
    (generation: number) => {
      if (!operationIsCurrent(generation)) return;
      nonAbortableOperationGenerationRef.current = null;
      setOperationWorking(null);
    },
    [operationIsCurrent],
  );

  const refreshInventoryForOperation = useCallback(
    (generation: number) => {
      if (!operationIsCurrent(generation)) return;
      invalidateInventory();
    },
    [invalidateInventory, operationIsCurrent],
  );

  useEffect(() => {
    if (mode === null) return;

    const generation = inventoryGeneration;
    const filter = makeFilter(scope, mode);
    const requestOwner = inventoryRequestOwnerRef.current + 1;
    inventoryRequestOwnerRef.current = requestOwner;
    const ownsRequest = () =>
      inventoryGenerationRef.current === generation &&
      inventoryRequestOwnerRef.current === requestOwner;

    const preparedRequest = preparedInventoryRequestRef.current;
    const responsePromise =
      preparedRequest?.generation === generation
        ? preparedRequest.promise
        : api.getPublicShares(filter);
    if (preparedRequest?.generation === generation) {
      preparedInventoryRequestRef.current = null;
    } else if (preparedRequest && preparedRequest.generation < generation) {
      preparedInventoryRequestRef.current = null;
    }

    const load = async () => {
      if (ownsRequest()) {
        setInventoryLoading(true);
        setInventoryError(null);
      }
      try {
        const response = await responsePromise;
        if (!ownsRequest()) return;
        setItems(response.items);
        setCursor(response.nextCursor);
        setTotal(response.totalCount);
      } catch (loadError) {
        if (!ownsRequest()) return;
        setInventoryError(
          loadError instanceof Error
            ? loadError.message
            : t("publicShareManagementLoadFailed"),
        );
      } finally {
        if (ownsRequest()) setInventoryLoading(false);
      }
    };

    void load();
  }, [inventoryGeneration, makeFilter, mode, scope, t]);

  const setScopeFilter = (nextScope: PublicShareManagementScope) => {
    if (!cancelExclusiveOperation() || nextScope === scope) return;
    setScope(nextScope);
    invalidateInventory();
  };

  const toggleModeFilter = (nextMode: PublicSessionShareMode) => {
    if (!cancelExclusiveOperation()) return;
    if (nextMode === "frozen") {
      setShowFrozenShares((value) => !value);
    } else {
      setShowLiveShares((value) => !value);
    }
    invalidateInventory();
  };

  const copyManagedShare = async (item: PublicShareManagementItem) => {
    if (!item.url || !cancelExclusiveOperation()) return;
    const generation = operationGenerationRef.current;
    const copied = await writeClipboardTextLater(Promise.resolve(item.url));
    if (!operationIsCurrent(generation)) return;
    setHighlightedShareId(item.shareId);
    setNotice(
      copied ? t("publicShareManagementCopied") : t("sessionShareManualCopy"),
    );
  };

  const createManagedShare = async (shareMode: PublicSessionShareMode) => {
    if (!creationIdentity || !creationReady) return;
    const generation = beginExclusiveOperation(`create:${shareMode}`, true);
    if (generation === null) return;
    const sharePromise = api.createPublicSessionShare({
      projectId: creationIdentity.projectId as UrlProjectId,
      sessionId: creationIdentity.sessionId,
      mode: shareMode,
      initialPrompt: creationIdentity.initialPrompt ?? undefined,
      title: creationIdentity.title ?? undefined,
    });
    const copyPromise = writeClipboardTextLater(
      sharePromise.then((created) => created.url),
    );
    try {
      const created = await sharePromise;
      if (!operationIsCurrent(generation)) return;
      const copied = await copyPromise;
      if (!operationIsCurrent(generation)) return;
      setHighlightedShareId(created.shareId ?? null);
      setNotice(
        copied ? t("sessionShareCopiedReadOnly") : t("sessionShareManualCopy"),
      );
      if (shareMode === "frozen") setShowFrozenShares(true);
      else setShowLiveShares(true);
      refreshInventoryForOperation(generation);
    } catch (createError) {
      if (!operationIsCurrent(generation)) return;
      setOperationError(
        createError instanceof Error
          ? createError.message
          : t("sessionShareFailed"),
      );
    } finally {
      finishExclusiveOperation(generation);
    }
  };

  const revokeManagedShare = async (item: PublicShareManagementItem) => {
    if (!cancelExclusiveOperation()) return;
    if (!window.confirm(t("publicShareManagementRevokeOneConfirm"))) return;
    const generation = beginExclusiveOperation(`revoke:${item.shareId}`, true);
    if (generation === null) return;
    try {
      const response = await api.revokePublicShare(item.shareId);
      if (!operationIsCurrent(generation)) return;
      if (response.revoked) refreshInventoryForOperation(generation);
    } catch (revokeError) {
      if (!operationIsCurrent(generation)) return;
      setOperationError(
        revokeError instanceof Error
          ? revokeError.message
          : t("sessionShareRevokeFailed"),
      );
    } finally {
      finishExclusiveOperation(generation);
    }
  };

  const freezeManagedShare = async (item: PublicShareManagementItem) => {
    if (item.mode !== "live" || !cancelExclusiveOperation()) return;
    if (!window.confirm(t("publicShareManagementFreezeOneConfirm"))) return;
    const generation = beginExclusiveOperation(`freeze:${item.shareId}`, true);
    if (generation === null) return;
    try {
      const response = await api.freezePublicShares([item.shareId]);
      if (!operationIsCurrent(generation)) return;
      setNotice(
        t("publicShareManagementFreezeCompleted", {
          count: response.convertedCount,
        }),
      );
      refreshInventoryForOperation(generation);
    } catch (freezeError) {
      if (!operationIsCurrent(generation)) return;
      setOperationError(
        freezeError instanceof Error
          ? freezeError.message
          : t("sessionShareFreezeFailed"),
      );
      refreshInventoryForOperation(generation);
    } finally {
      finishExclusiveOperation(generation);
    }
  };

  const scopeLabel =
    scope === "session"
      ? t("publicShareManagementScopeSession")
      : scope === "project"
        ? t("publicShareManagementScopeProject")
        : t("publicShareManagementScopeAll");

  const categoryConfirmLabel = (
    pending: PendingCategoryAction,
    clickAgain: boolean,
  ) => {
    if (pending.action === "freeze") {
      return t(
        clickAgain
          ? "publicShareManagementFreezeConfirmAgain"
          : "publicShareManagementFreezeConfirm",
        {
          count: pending.shareIds.length,
          viewers: pending.viewerCount,
          scope: pending.scopeLabel,
        },
      );
    }
    return pending.typeLabel
      ? t(
          clickAgain
            ? "publicShareManagementRevokeTypeConfirmAgain"
            : "publicShareManagementRevokeTypeConfirm",
          {
            count: pending.shareIds.length,
            viewers: pending.viewerCount,
            type: pending.typeLabel,
            scope: pending.scopeLabel,
          },
        )
      : t(
          clickAgain
            ? "publicShareManagementRevokeScopeConfirmAgain"
            : "publicShareManagementRevokeScopeConfirm",
          {
            count: pending.shareIds.length,
            viewers: pending.viewerCount,
            scope: pending.scopeLabel,
          },
        );
  };

  const prepareCategoryAction = async (target: CategoryActionTarget) => {
    const generation = beginExclusiveOperation(
      `prepare-${target.action}:${target.key}`,
    );
    if (generation === null) return;
    const filter = makeFilter(target.scope, target.mode);
    setScope(target.scope);
    setShowFrozenShares(target.mode === undefined || target.mode === "frozen");
    setShowLiveShares(target.mode === undefined || target.mode === "live");
    const inventoryGeneration = invalidateInventory();
    let firstPageLoaded = false;

    try {
      const firstPagePromise = api.getPublicShares({
        ...filter,
        cursor: undefined,
      });
      preparedInventoryRequestRef.current = {
        generation: inventoryGeneration,
        promise: firstPagePromise,
      };
      const shares: PublicShareManagementItem[] = [];
      let response = await firstPagePromise;
      if (!operationIsCurrent(generation)) return;
      firstPageLoaded = true;
      shares.push(...response.items);
      let nextCursor = response.nextCursor ?? undefined;
      while (nextCursor) {
        response = await api.getPublicShares({
          ...filter,
          cursor: nextCursor,
        });
        if (!operationIsCurrent(generation)) return;
        shares.push(...response.items);
        nextCursor = response.nextCursor ?? undefined;
      }

      const actionShares =
        target.action === "freeze"
          ? shares.filter((share) => share.mode === "live")
          : shares;
      if (actionShares.length === 0) {
        setNotice(
          target.action === "freeze"
            ? t("publicShareManagementFreezeEmpty", {
                scope: target.scopeLabel,
              })
            : target.typeLabel
              ? t("publicShareManagementRevokeTypeEmpty", {
                  type: target.typeLabel,
                  scope: target.scopeLabel,
                })
              : t("publicShareManagementRevokeScopeEmpty", {
                  scope: target.scopeLabel,
                }),
        );
        return;
      }

      const shareIds = Object.freeze(
        actionShares.map((share) => share.shareId),
      );
      setPendingCategoryAction({
        ...target,
        generation,
        shareIds,
        viewerCount: actionShares.reduce(
          (sum, share) => sum + share.activeViewerCount,
          0,
        ),
      });
    } catch (actionError) {
      if (!operationIsCurrent(generation) || !firstPageLoaded) return;
      setOperationError(
        actionError instanceof Error
          ? actionError.message
          : t(
              target.action === "freeze"
                ? "sessionShareFreezeFailed"
                : "sessionShareRevokeFailed",
            ),
      );
    } finally {
      finishExclusiveOperation(generation);
    }
  };

  const confirmCategoryAction = async () => {
    const pending = pendingCategoryAction;
    if (!pending || pending.generation !== operationGenerationRef.current)
      return;
    const shareIds = Object.freeze([...pending.shareIds]);
    const generation = beginExclusiveOperation(
      `confirm-${pending.action}:${pending.key}`,
      true,
    );
    if (generation === null) return;
    const revokedShareIds = new Set<string>();

    try {
      if (pending.action === "freeze") {
        const response = await api.freezePublicShares(shareIds);
        if (!operationIsCurrent(generation)) return;
        setNotice(
          t("publicShareManagementFreezeCompleted", {
            count: response.convertedCount,
          }),
        );
      } else {
        for (const shareId of shareIds) {
          const response = await api.revokePublicShare(shareId);
          if (!operationIsCurrent(generation)) return;
          if (response.revoked) revokedShareIds.add(shareId);
        }
        if (!operationIsCurrent(generation)) return;
        setNotice(
          pending.typeLabel
            ? t("publicShareManagementRevokeTypeRevoked", {
                count: revokedShareIds.size,
                type: pending.typeLabel,
                scope: pending.scopeLabel,
              })
            : t("publicShareManagementRevokeScopeRevoked", {
                count: revokedShareIds.size,
                scope: pending.scopeLabel,
              }),
        );
      }
      refreshInventoryForOperation(generation);
    } catch (actionError) {
      if (!operationIsCurrent(generation)) return;
      setOperationError(
        actionError instanceof Error
          ? actionError.message
          : t(
              pending.action === "freeze"
                ? "sessionShareFreezeFailed"
                : "sessionShareRevokeFailed",
            ),
      );
      if (pending.action === "freeze" || revokedShareIds.size > 0) {
        refreshInventoryForOperation(generation);
      }
    } finally {
      finishExclusiveOperation(generation);
    }
  };

  const loadMore = async () => {
    if (!cursor || mode === null || inventoryLoading || operationWorking)
      return;
    if (!cancelExclusiveOperation()) return;
    const generation = inventoryGenerationRef.current;
    const filter = makeFilter(scope, mode);
    const capturedCursor = cursor;
    const requestOwner = inventoryRequestOwnerRef.current + 1;
    inventoryRequestOwnerRef.current = requestOwner;
    const ownsRequest = () =>
      inventoryGenerationRef.current === generation &&
      inventoryRequestOwnerRef.current === requestOwner;

    if (ownsRequest()) {
      setInventoryLoading(true);
      setInventoryError(null);
    }
    try {
      const response = await api.getPublicShares({
        ...filter,
        cursor: capturedCursor,
      });
      if (!ownsRequest()) return;
      setItems((current) => [...current, ...response.items]);
      setCursor(response.nextCursor);
      setTotal(response.totalCount);
    } catch (loadError) {
      if (!ownsRequest()) return;
      setInventoryError(
        loadError instanceof Error
          ? loadError.message
          : t("publicShareManagementLoadFailed"),
      );
    } finally {
      if (ownsRequest()) setInventoryLoading(false);
    }
  };

  const mutationsDisabled = operationWorking !== null;
  const operationInvalidationDisabled =
    nonAbortableOperationGenerationRef.current !== null;
  const creationControlsVisible = !!creationIdentity && creationReady;

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
            {creationIdentity && (
              <div
                className={styles.filterGroup}
                role="group"
                aria-label={t("publicShareManagementScopeFilter")}
              >
                <span>{t("publicShareManagementScopeFilter")}</span>
                {(["all", "project", "session"] as const).map((scopeOption) => {
                  const optionLabel =
                    scopeOption === "all"
                      ? t("publicShareManagementScopeAll")
                      : scopeOption === "project"
                        ? t("publicShareManagementScopeProject")
                        : t("publicShareManagementScopeSession");
                  const categoryKey = `scope:${scopeOption}` as const;
                  const pending =
                    pendingCategoryAction?.action === "revoke" &&
                    pendingCategoryAction.key === categoryKey
                      ? pendingCategoryAction
                      : null;
                  const revokeLabel = pending
                    ? categoryConfirmLabel(pending, false)
                    : t("publicShareManagementRevokeScope", {
                        scope: optionLabel,
                      });
                  return (
                    <div className={styles.scopeRow} key={scopeOption}>
                      <button
                        type="button"
                        className={`${styles.filterButton} ${
                          scope === scopeOption ? styles.filterButtonActive : ""
                        }`}
                        aria-pressed={scope === scopeOption}
                        disabled={operationInvalidationDisabled}
                        onClick={() => setScopeFilter(scopeOption)}
                      >
                        <span className={styles.filterIcon}>
                          <ShareFilterIcon kind={scopeOption} />
                        </span>
                        <span>{optionLabel}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.revokeTypeButton}
                        disabled={mutationsDisabled}
                        onClick={() =>
                          void (pending
                            ? confirmCategoryAction()
                            : prepareCategoryAction({
                                action: "revoke",
                                key: categoryKey,
                                scope: scopeOption,
                                scopeLabel: optionLabel,
                              }))
                        }
                        title={revokeLabel}
                        aria-label={revokeLabel}
                      >
                        {operationWorking?.endsWith(categoryKey) ? (
                          "…"
                        ) : pending ? (
                          <ConfirmIcon />
                        ) : (
                          <RevokeIcon />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div
              className={styles.filterGroup}
              role="group"
              aria-label={t("publicShareManagementModeFilter")}
            >
              <span>{t("publicShareManagementModeFilter")}</span>
              {(["frozen", "live"] as const).map((modeOption) => {
                const selected =
                  modeOption === "frozen" ? showFrozenShares : showLiveShares;
                const pendingRevoke =
                  pendingCategoryAction?.action === "revoke" &&
                  pendingCategoryAction.key === `mode:${modeOption}` &&
                  pendingCategoryAction.scope === scope
                    ? pendingCategoryAction
                    : null;
                const pendingFreeze =
                  pendingCategoryAction?.action === "freeze" &&
                  pendingCategoryAction.key === "mode:live" &&
                  pendingCategoryAction.scope === scope
                    ? pendingCategoryAction
                    : null;
                const typeLabel =
                  modeOption === "live"
                    ? t("publicShareLiveBadge")
                    : t("publicShareManagementModeReadOnly");
                const revokeLabel = pendingRevoke
                  ? categoryConfirmLabel(pendingRevoke, false)
                  : t("publicShareManagementRevokeType", {
                      type: typeLabel,
                      scope: scopeLabel,
                    });
                const freezeLabel = pendingFreeze
                  ? categoryConfirmLabel(pendingFreeze, false)
                  : t("publicShareManagementFreeze", { scope: scopeLabel });
                const freezeWorking =
                  operationWorking?.includes("-freeze:") === true &&
                  operationWorking.endsWith("mode:live");
                const revokeWorking =
                  operationWorking?.includes("-revoke:") === true &&
                  operationWorking.endsWith(`mode:${modeOption}`);
                return (
                  <div
                    className={`${styles.filterRow} ${
                      creationControlsVisible ? "" : styles.filterRowNoCreate
                    } ${
                      modeOption === "live" && selectiveFreezeAvailable
                        ? styles.filterRowWithFreeze
                        : ""
                    }`}
                    key={modeOption}
                  >
                    <button
                      type="button"
                      className={`${styles.filterButton} ${
                        selected ? styles.filterButtonActive : ""
                      }`}
                      aria-pressed={selected}
                      disabled={operationInvalidationDisabled}
                      onClick={() => toggleModeFilter(modeOption)}
                    >
                      <span className={styles.filterIcon}>
                        <ShareFilterIcon kind={modeOption} />
                      </span>
                      <span>{typeLabel}</span>
                    </button>
                    {creationControlsVisible && (
                      <button
                        type="button"
                        className={styles.addButton}
                        disabled={mutationsDisabled}
                        onClick={() => void createManagedShare(modeOption)}
                        title={t("publicShareManagementCreate", {
                          type: typeLabel,
                        })}
                        aria-label={t("publicShareManagementCreate", {
                          type: typeLabel,
                        })}
                      >
                        <PlusIcon />
                      </button>
                    )}
                    {modeOption === "live" && selectiveFreezeAvailable && (
                      <button
                        type="button"
                        className={styles.freezeTypeButton}
                        disabled={mutationsDisabled}
                        onClick={() =>
                          void (pendingFreeze
                            ? confirmCategoryAction()
                            : prepareCategoryAction({
                                action: "freeze",
                                key: "mode:live",
                                mode: "live",
                                scope,
                                scopeLabel,
                                typeLabel,
                              }))
                        }
                        title={freezeLabel}
                        aria-label={freezeLabel}
                      >
                        {freezeWorking ? (
                          "…"
                        ) : pendingFreeze ? (
                          <ConfirmIcon />
                        ) : (
                          <FreezeIcon />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.revokeTypeButton}
                      disabled={mutationsDisabled}
                      onClick={() =>
                        void (pendingRevoke
                          ? confirmCategoryAction()
                          : prepareCategoryAction({
                              action: "revoke",
                              key: `mode:${modeOption}`,
                              mode: modeOption,
                              scope,
                              scopeLabel,
                              typeLabel,
                            }))
                      }
                      title={revokeLabel}
                      aria-label={revokeLabel}
                    >
                      {revokeWorking ? (
                        "…"
                      ) : pendingRevoke ? (
                        <ConfirmIcon />
                      ) : (
                        <RevokeIcon />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>

          <div className={styles.managerMain}>
            {operationError && (
              <div className={styles.error} role="alert">
                {operationError}
              </div>
            )}
            {notice && (
              <div className={styles.notice} role="status">
                {notice}
              </div>
            )}
            {inventoryError ? (
              <div className={styles.error} role="alert">
                {inventoryError}
              </div>
            ) : inventoryLoading && items.length === 0 ? (
              <div className={styles.empty} role="status">
                {t("publicShareManagementLoading")}
              </div>
            ) : items.length === 0 ? (
              <div className={styles.empty}>
                {t("publicShareManagementEmpty")}
              </div>
            ) : (
              <div className={styles.list} role="list">
                {items.map((item) => {
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
                        <span
                          className={`${styles.rowTypeIcon} ${
                            item.mode === "live" ? styles.rowTypeIconLive : ""
                          }`}
                          title={
                            item.mode === "live"
                              ? t("publicShareLiveBadge")
                              : t("publicShareManagementModeReadOnly")
                          }
                          aria-label={
                            item.mode === "live"
                              ? t("publicShareLiveBadge")
                              : t("publicShareManagementModeReadOnly")
                          }
                          role="img"
                        >
                          <ShareFilterIcon kind={item.mode} />
                        </span>
                        <button
                          type="button"
                          className={styles.iconButton}
                          disabled={!item.url || operationInvalidationDisabled}
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
                        {item.mode === "live" && selectiveFreezeAvailable && (
                          <button
                            type="button"
                            className={`${styles.iconButton} ${styles.iconButtonFreeze}`}
                            disabled={mutationsDisabled}
                            onClick={() => void freezeManagedShare(item)}
                            title={t("publicShareManagementFreezeOne")}
                            aria-label={t("publicShareManagementFreezeOne")}
                          >
                            {operationWorking === `freeze:${item.shareId}` ? (
                              "…"
                            ) : (
                              <FreezeIcon />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                          disabled={mutationsDisabled}
                          onClick={() => void revokeManagedShare(item)}
                          title={t("publicShareManagementRevokeOne")}
                          aria-label={t("publicShareManagementRevokeOne")}
                        >
                          {operationWorking === `revoke:${item.shareId}` ? (
                            "…"
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

            {!inventoryError && cursor && (
              <button
                type="button"
                className="settings-button settings-button-secondary"
                disabled={inventoryLoading || mutationsDisabled}
                onClick={() => void loadMore()}
              >
                {inventoryLoading
                  ? t("publicShareManagementLoading")
                  : t("publicShareManagementLoadMore")}
              </button>
            )}
            {!inventoryError && (
              <div className={styles.count}>
                {t("publicShareManagementCount", { count: total })}
              </div>
            )}
          </div>
        </div>
        {pendingCategoryAction && (
          <div
            className={
              pendingCategoryAction.action === "freeze"
                ? styles.freezeConfirmationBanner
                : styles.revokeConfirmationBanner
            }
            role="status"
          >
            {categoryConfirmLabel(pendingCategoryAction, true)}
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

function RevokeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function FreezeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7M8 10v1.5" />
    </svg>
  );
}

function ConfirmIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 8.5 3.2 3.2L13 4.8" />
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
    project: <path d="M3 6.5h7l2 2h9v10.5H3zM3 6.5V5h7l2 2" />,
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
