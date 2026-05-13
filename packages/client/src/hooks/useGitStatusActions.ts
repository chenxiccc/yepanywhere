import type {
  GitBranchInfo,
  GitMergeStrategy,
  GitStatusInfo,
  GitUndoCommitResponse,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { UI_KEYS } from "../lib/storageKeys";

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

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function useGitStatusActions({
  projectId,
  status,
  refetch,
  t,
  selectedCommitPaths,
  commitMessage,
  setCommitMessage,
}: {
  projectId: string;
  status: GitStatusInfo;
  refetch: () => Promise<void>;
  t: Translate;
  selectedCommitPaths: string[];
  commitMessage: string;
  setCommitMessage: (value: string) => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<GitAction | null>(null);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchMenuError, setBranchMenuError] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [branchSwitchMode, setBranchSwitchMode] = useState<"stash" | "carry">(
    "stash",
  );
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
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
        await refetch();
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : t("gitStatusActionFailed"),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [refetch, t],
  );

  const loadBranches = useCallback(async () => {
    try {
      const result = await api.getGitBranches(projectId);
      setBranches(result.branches);
      setBranchMenuError(null);
    } catch (err) {
      setBranchMenuError(
        err instanceof Error ? err.message : t("gitStatusActionFailed"),
      );
    }
  }, [projectId, t]);

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

  const handleBranchSelect = useCallback(
    (branchName: string) => {
      setBranchMenuOpen(false);
      if (branchName === status.branch) return;
      if (status.files.length > 0) {
        setBranchSwitchMode("stash");
        setPendingBranch(branchName);
        return;
      }

      void runAction("switch", () =>
        api.switchGitBranch(projectId, {
          targetBranch: branchName,
          stashCurrentChanges: false,
        }),
      );
    },
    [projectId, runAction, status.branch, status.files.length],
  );

  const confirmBranchSwitch = useCallback(
    (stashCurrentChanges: boolean) => {
      if (!pendingBranch) return;
      const targetBranch = pendingBranch;
      setPendingBranch(null);
      void runAction("switch", () =>
        api.switchGitBranch(projectId, {
          targetBranch,
          stashCurrentChanges,
        }),
      );
    },
    [pendingBranch, projectId, runAction],
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
        await api.mergeGitBranch(projectId, { sourceBranch, strategy });
        await refetch();
        setMergeModalOpen(false);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("gitStatusActionFailed");
        setMergeError(message);
        setActionError(message);
      } finally {
        setBusyAction(null);
      }
    },
    [projectId, refetch, t],
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
        action === "fetch" ? api.fetchGit(projectId) : api.pushGit(projectId),
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
    (stashRef: string, onSuccess?: () => void) => {
      if (!stashRef) return;
      void runAction(
        "discardStash",
        () => api.discardGitStash(projectId, stashRef),
        onSuccess,
      );
    },
    [projectId, runAction],
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
    discardConfirmOpen,
    handleBranchSelect,
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
    mergeError,
    mergeModalOpen,
    pendingBranch,
    setBranchMenuOpen,
    setBranchSwitchMode,
    setDiscardConfirmOpen,
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
