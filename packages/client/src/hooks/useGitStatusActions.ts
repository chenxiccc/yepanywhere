import type {
  GitBranchInfo,
  GitMergeStrategy,
  SourceManagerStatusInfo,
  GitUndoCommitResponse,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { UI_KEYS } from "../lib/storageKeys";

// 分支列表客户端 SWR 缓存：projectId -> { branches, fetchedAt, inFlight }。
// 打开下拉时先回显缓存秒开，后台刷新；TTL 内重复打开不发请求；inFlight 去重连点。
// Branch list client SWR cache: projectId -> { branches, fetchedAt, inFlight }.
// On menu open, replay cache instantly then refresh in background; repeated opens
// within TTL skip the request; in-flight dedup handles rapid toggles.
const BRANCHES_TTL_MS = 8000;
type BranchesCacheEntry = {
  branches: GitBranchInfo[];
  fetchedAt: number;
  inFlight: Promise<GitBranchInfo[]> | null;
};
const branchesCache = new Map<string, BranchesCacheEntry>();

export type GitAction =
  | "commit"
  | "undo"
  | "push"
  | "fetch"
  | "switch"
  | "merge"
  | "stash"
  | "discard"
  | "restoreStash"
  | "discardStash";

type PendingBranchSwitch = {
  targetBranch: string;
};

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function useGitStatusActions({
  projectId,
  status,
  refetch,
  applyStatus,
  t,
  selectedCommitPaths,
  commitMessage,
  setCommitMessage,
  onSwitchSuccess,
}: {
  projectId: string;
  status: SourceManagerStatusInfo;
  refetch: () => Promise<void>;
  /** 写端点响应若含 status 则直接应用，省掉一次 refetch / If the write-endpoint
   *  response carries a status field, apply it directly, saving one refetch. */
  applyStatus: (status: SourceManagerStatusInfo) => void;
  t: Translate;
  selectedCommitPaths: string[];
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  /** checkout 成功后回调（用于让查看分支跟随新当前分支）/ Callback after successful checkout */
  onSwitchSuccess?: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<GitAction | null>(null);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchMenuError, setBranchMenuError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<PendingBranchSwitch | null>(
    null,
  );
  const [branchSwitchMode, setBranchSwitchMode] = useState<"stash" | "carry">(
    "stash",
  );
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [discardStashConfirmRef, setDiscardStashConfirmRef] = useState<
    string | null
  >(null);
  const [hideUndoWarning, setHideUndoWarning] = useState(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.getItem !== "function"
    ) {
      return false;
    }

    return localStorage.getItem(UI_KEYS.gitUndoHideWarning) === "true";
  });
  const [hideUndoWarningChecked, setHideUndoWarningChecked] = useState(false);
  const [hideDiscardWarning, setHideDiscardWarning] = useState(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.getItem !== "function"
    ) {
      return false;
    }

    return localStorage.getItem(UI_KEYS.gitDiscardHideWarning) === "true";
  });
  const [hideDiscardWarningChecked, setHideDiscardWarningChecked] =
    useState(false);

  const runAction = useCallback(
    async <T>(
      action: GitAction,
      runner: () => Promise<T>,
      onSuccess?: (result: T) => void,
    ) => {
      setBusyAction(action);
      setActionError(null);
      try {
        const result = await runner();
        onSuccess?.(result);
        // 写端点响应通常含 status（commit/switch/push/fetch/stash/discard/merge 等），
        // 直接应用新鲜 status，省掉一次 refetch；无 status 字段时回退 refetch。
        // Write-endpoint responses usually carry status; apply it directly to save a
        // refetch. Fall back to refetch when there is no status field.
        const maybeStatus = (
          result as { status?: SourceManagerStatusInfo }
        )?.status;
        if (maybeStatus && typeof maybeStatus === "object") {
          applyStatus(maybeStatus);
        } else {
          await refetch();
        }
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : t("sourceManagerActionFailed"),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [applyStatus, refetch, t],
  );

  const loadBranches = useCallback(async () => {
    try {
      const now = Date.now();
      const existing = branchesCache.get(projectId);
      // TTL 内且有数据：跳过请求 / Within TTL with existing data: skip the request
      if (
        existing?.fetchedAt &&
        now - existing.fetchedAt < BRANCHES_TTL_MS
      ) {
        setBranches(existing.branches);
        return;
      }
      // inFlight 去重：复用进行中的请求 / Dedup: reuse an in-flight request
      if (existing?.inFlight) {
        const branches = await existing.inFlight;
        setBranches(branches);
        return;
      }
      const promise = api
        .getGitBranches(projectId)
        .then((result) => {
          branchesCache.set(projectId, {
            branches: result.branches,
            fetchedAt: Date.now(),
            inFlight: null,
          });
          return result.branches;
        })
        .finally(() => {
          // 失败时清 inFlight（不写 branches），下次重试
          // Clear inFlight on failure (no branches cached); next open retries
          const current = branchesCache.get(projectId);
          if (current?.inFlight === promise) current.inFlight = null;
        });
      if (existing) {
        existing.inFlight = promise;
      } else {
        branchesCache.set(projectId, {
          branches: [],
          fetchedAt: 0,
          inFlight: promise,
        });
      }
      const branches = await promise;
      setBranches(branches);
      setBranchMenuError(null);
    } catch (err) {
      setBranchMenuError(
        err instanceof Error ? err.message : t("sourceManagerActionFailed"),
      );
    }
  }, [projectId, t]);

  // 写后本地失效：switch/create/merge 后当前分支或分支列表变了，下次打开重新拉
  // Invalidate locally after a write: switch/create/merge change the current
  // branch or branch list, so the next open must re-fetch.
  const invalidateBranches = useCallback(() => {
    branchesCache.delete(projectId);
  }, [projectId]);

  const syncAction = useMemo<"fetch" | "push" | null>(
    () =>
      status.upstream && status.behind === 0 && status.ahead > 0
        ? "push"
        : status.branch
          ? "fetch"
          : null,
    [status.ahead, status.behind, status.branch, status.upstream],
  );

  const alternateSyncAction = useMemo<"fetch" | "push" | null>(() => {
    if (syncAction === "fetch") {
      return status.ahead > 0 ? "push" : null;
    }
    if (syncAction === "push") {
      return "fetch";
    }
    return null;
  }, [status.ahead, syncAction]);

  const handleToggleBranchMenu = useCallback(() => {
    setBranchMenuOpen((isOpen) => {
      const nextOpen = !isOpen;
      if (nextOpen) {
        void loadBranches();
      }
      return nextOpen;
    });
  }, [loadBranches]);

  const handleSwitchBranch = useCallback(
    (branchName: string) => {
      setBranchMenuOpen(false);
      if (branchName === status.branch) return;
      if (status.files.length > 0) {
        setBranchSwitchMode("stash");
        setPendingBranch({ targetBranch: branchName });
        return;
      }

      void runAction(
        "switch",
        () =>
          api.switchGitBranch(projectId, {
            targetBranch: branchName,
            stashCurrentChanges: false,
          }),
        // switch 后当前分支变了，本地失效分支缓存，下次打开重新拉
        // After switch the current branch changed; invalidate branch cache locally
        () => {
          invalidateBranches();
          onSwitchSuccess?.();
        },
      );
    },
    [
      projectId,
      runAction,
      status.branch,
      status.files.length,
      onSwitchSuccess,
      invalidateBranches,
    ],
  );

  const handleCreateBranch = useCallback(
    (branchName: string, baseBranch?: string) => {
      void runAction(
        "switch",
        async () => {
          await api.createGitBranch(projectId, { branchName, baseBranch });
          if (status.files.length > 0) {
            // 有未提交改动：交给 modal 处理，此处未真正 switch，不触发跟随
            // Uncommitted changes: deferred to modal; no real switch here, skip follow
            setBranchSwitchMode("stash");
            setPendingBranch({ targetBranch: branchName });
            return false;
          }

          await api.switchGitBranch(projectId, {
            targetBranch: branchName,
            stashCurrentChanges: false,
          });
          return true;
        },
        // 仅在真正 switch 成功时让查看分支跟随 / Only follow when actually switched
        (switched) => {
          if (switched) {
            invalidateBranches();
            onSwitchSuccess?.();
          }
        },
      );
    },
    [
      projectId,
      runAction,
      status.files.length,
      onSwitchSuccess,
      invalidateBranches,
    ],
  );

  const confirmBranchSwitch = useCallback(
    (stashCurrentChanges: boolean) => {
      if (!pendingBranch) return;
      const { targetBranch } = pendingBranch;
      setPendingBranch(null);
      void runAction(
        "switch",
        () =>
          api.switchGitBranch(projectId, {
            targetBranch,
            stashCurrentChanges,
          }),
        // switch 后当前分支变了，本地失效分支缓存 / Invalidate branch cache after switch
        () => {
          invalidateBranches();
          onSwitchSuccess?.();
        },
      );
    },
    [pendingBranch, projectId, runAction, onSwitchSuccess, invalidateBranches],
  );

  const handleOpenMergeModal = useCallback(() => {
    setBranchMenuOpen(false);
    setMergeError(null);
    void loadBranches();
    setMergeModalOpen(true);
  }, [loadBranches]);

  const handleMergeBranch = useCallback(
    async (sourceBranch: string, strategy: GitMergeStrategy) => {
      if (!sourceBranch) return;
      setBusyAction("merge");
      setActionError(null);
      setMergeError(null);
      try {
        // 写端点响应含新鲜 status，直接应用，省掉一次 refetch
        // Write-endpoint response carries fresh status; apply directly, skip refetch
        const result = await api.mergeGitBranch(projectId, {
          sourceBranch,
          strategy,
        });
        applyStatus(result.status);
        // merge 可能新增 merge commit，影响 recent 分支排序，本地失效分支缓存
        // merge may add a merge commit affecting recent-branch ordering; invalidate
        invalidateBranches();
        setMergeModalOpen(false);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("sourceManagerActionFailed");
        setMergeError(message);
        setActionError(message);
      } finally {
        setBusyAction(null);
      }
    },
    [applyStatus, invalidateBranches, projectId, t],
  );

  const handleCommit = useCallback(() => {
    void runAction(
      "commit",
      () => api.commitGit(projectId, commitMessage.trim(), selectedCommitPaths),
      () => setCommitMessage(""),
    );
  }, [
    commitMessage,
    projectId,
    runAction,
    selectedCommitPaths,
    setCommitMessage,
  ]);

  const performUndo = useCallback(() => {
    void runAction(
      "undo",
      () => api.undoGitCommit(projectId),
      (result: GitUndoCommitResponse) => {
        if (commitMessage.trim().length === 0) {
          setCommitMessage(result.undoneCommitMessage);
        }
      },
    );
  }, [commitMessage, projectId, runAction, setCommitMessage]);

  const handleUndoClick = useCallback(() => {
    if (busyAction !== null) return;

    if (status.files.length > 0 && !hideUndoWarning) {
      setHideUndoWarningChecked(false);
      setUndoConfirmOpen(true);
      return;
    }

    performUndo();
  }, [busyAction, hideUndoWarning, performUndo, status.files.length]);

  const handleConfirmUndo = useCallback(() => {
    if (
      hideUndoWarningChecked &&
      typeof localStorage !== "undefined" &&
      typeof localStorage.setItem === "function"
    ) {
      localStorage.setItem(UI_KEYS.gitUndoHideWarning, "true");
      setHideUndoWarning(true);
    }

    setUndoConfirmOpen(false);
    performUndo();
  }, [hideUndoWarningChecked, performUndo]);

  const handleSync = useCallback(
    (action: "fetch" | "push") => {
      void runAction(action, () =>
        action === "fetch"
          ? api.fetchSourceManager(projectId)
          : api.pushSourceManager(projectId),
      );
    },
    [projectId, runAction],
  );

  const handleStashAllChanges = useCallback(() => {
    if (selectedCommitPaths.length === 0) return;
    void runAction("stash", () =>
      api.stashGitChanges(projectId, selectedCommitPaths),
    );
  }, [projectId, runAction, selectedCommitPaths]);

  const handleDiscardAllChanges = useCallback(() => {
    if (busyAction !== null || selectedCommitPaths.length === 0) return;
    if (hideDiscardWarning) {
      void runAction("discard", () =>
        api.discardGitChanges(projectId, selectedCommitPaths),
      );
      return;
    }

    setHideDiscardWarningChecked(false);
    setDiscardConfirmOpen(true);
  }, [
    busyAction,
    hideDiscardWarning,
    projectId,
    runAction,
    selectedCommitPaths,
  ]);

  const confirmDiscardAllChanges = useCallback(() => {
    if (
      hideDiscardWarningChecked &&
      typeof localStorage !== "undefined" &&
      typeof localStorage.setItem === "function"
    ) {
      localStorage.setItem(UI_KEYS.gitDiscardHideWarning, "true");
      setHideDiscardWarning(true);
    }

    setDiscardConfirmOpen(false);
    void runAction("discard", () =>
      api.discardGitChanges(projectId, selectedCommitPaths),
    );
  }, [hideDiscardWarningChecked, projectId, runAction, selectedCommitPaths]);

  const handleRestoreStash = useCallback(
    (stashRef: string, onSuccess?: () => void) => {
      if (!stashRef) return;
      void runAction(
        "restoreStash",
        () => api.restoreGitStash(projectId, stashRef),
        onSuccess,
      );
    },
    [projectId, runAction],
  );

  const handleDiscardStash = useCallback(
    (stashRef: string) => {
      if (busyAction !== null || !stashRef) return;
      setDiscardStashConfirmRef(stashRef);
    },
    [busyAction],
  );

  const confirmDiscardStash = useCallback(
    (onSuccess?: () => void) => {
      if (!discardStashConfirmRef) return;
      const stashRef = discardStashConfirmRef;
      setDiscardStashConfirmRef(null);
      void runAction(
        "discardStash",
        () => api.discardGitStash(projectId, stashRef),
        onSuccess,
      );
    },
    [discardStashConfirmRef, projectId, runAction],
  );

  return {
    actionError,
    alternateSyncAction,
    branchMenuError,
    branchMenuOpen,
    branchSwitchMode,
    branches,
    busyAction,
    confirmBranchSwitch,
    confirmDiscardAllChanges,
    confirmDiscardStash,
    discardConfirmOpen,
    discardStashConfirmRef,
    handleSwitchBranch,
    handleCreateBranch,
    handleCommit,
    handleConfirmUndo,
    handleDiscardAllChanges,
    handleDiscardStash,
    handleMergeBranch,
    handleOpenMergeModal,
    handleRestoreStash,
    handleStashAllChanges,
    handleSync,
    handleToggleBranchMenu,
    handleUndoClick,
    hideDiscardWarningChecked,
    hideUndoWarningChecked,
    createModalOpen,
    mergeError,
    mergeModalOpen,
    pendingBranch,
    setBranchMenuOpen,
    setBranchSwitchMode,
    setCreateModalOpen,
    setDiscardConfirmOpen,
    setDiscardStashConfirmRef,
    setFileActionWarnings: {
      setHideDiscardWarningChecked,
      setHideUndoWarningChecked,
    },
    setMergeError,
    setMergeModalOpen,
    setPendingBranch,
    setSyncMenuOpen,
    setUndoConfirmOpen,
    syncAction,
    syncMenuOpen,
    undoConfirmOpen,
  };
}
