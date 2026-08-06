import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
  GitRevisionComparison,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useCommitSearchIndex } from "../hooks/useCommitSearchIndex";
import type { TranslationFn } from "../i18n";

const COMMIT_PAGE_SIZE = 50;
export const WORKING_TREE_KEY = "working-tree";

/**
 * Owns the commit browser's remote data and selection state. Rendering,
 * responsive navigation, and source action menus stay in CommitBrowser; this
 * boundary keeps list/detail/comparison requests and their coupled selection
 * invariants out of the three-pane view.
 */
export function useCommitBrowserModel({
  projectId,
  status,
  isWideScreen,
  initialSha,
  supportsProjections,
  onProjectionUnavailable,
  t,
}: {
  projectId: string;
  status?: GitStatusInfo;
  isWideScreen: boolean;
  initialSha?: string;
  supportsProjections: boolean;
  onProjectionUnavailable: () => void;
  t: TranslationFn;
}) {
  const [commits, setCommits] = useState<GitRecentCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialSha ?? null,
  );
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [compareToHead, setCompareToHead] = useState(false);
  const [comparison, setComparison] = useState<GitRevisionComparison | null>(
    null,
  );
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [messageView, setMessageView] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexRequested, setSearchIndexRequested] = useState(false);

  const searchActive = searchQuery.trim().length > 0;
  const searchIndex = useCommitSearchIndex(
    projectId,
    searchQuery,
    searchIndexRequested,
  );
  const searchedOrRecentCommits = searchActive ? searchIndex.results : commits;
  const selectedIsWorkingTree = selectedKey === WORKING_TREE_KEY;
  const selectedSha =
    selectedKey && !selectedIsWorkingTree ? selectedKey : null;
  const displayedCommits = useMemo(() => {
    if (
      !detail ||
      detail.hash !== selectedSha ||
      searchedOrRecentCommits.some((commit) => commit.hash === detail.hash)
    ) {
      return searchedOrRecentCommits;
    }
    // A blame hash can point beyond the recent page. Keep that direct revision
    // visible while its detail is open instead of silently selecting a
    // different recent commit.
    return [detail, ...searchedOrRecentCommits];
  }, [detail, searchedOrRecentCommits, selectedSha]);
  // Working tree is a real selectable revision even when its diff is empty.
  // A clean tree must never fall through to selecting the newest commit.
  const showWorkingTreeRevision = status !== undefined;
  const displayedKeys = useMemo(
    () => [
      ...(showWorkingTreeRevision ? [WORKING_TREE_KEY] : []),
      ...displayedCommits.map((commit) => commit.hash),
    ],
    [displayedCommits, showWorkingTreeRevision],
  );

  useEffect(() => {
    if (initialSha) setSelectedKey(initialSha);
  }, [initialSha]);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setListError(null);
    setCommits([]);
    setSelectedKey(initialSha ?? null);
    api
      .getGitCommits(projectId, { limit: COMMIT_PAGE_SIZE })
      .then((res) => {
        if (cancelled) return;
        setCommits(res.commits);
        setHasMore(res.hasMore);
        setLoadingList(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(
          err instanceof Error ? err.message : t("gitStatusLoading"),
        );
        setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialSha, projectId, t]);

  // Desktop opens the first available revision. Unified Source Control always
  // supplies status, so that revision is Working tree even when it is clean.
  // An explicit blame-hash selection remains authoritative while detail loads.
  useEffect(() => {
    const first = displayedKeys[0];
    if (!isWideScreen || !first) return;
    setSelectedKey((current) =>
      current &&
      (displayedKeys.includes(current) ||
        (initialSha !== undefined && current === initialSha))
        ? current
        : first,
    );
  }, [displayedKeys, initialSha, isWideScreen]);

  const loadMore = useCallback(async () => {
    try {
      const res = await api.getGitCommits(projectId, {
        limit: COMMIT_PAGE_SIZE,
        skip: commits.length,
      });
      setCommits((previous) => {
        const seen = new Set(previous.map((commit) => commit.hash));
        return [
          ...previous,
          ...res.commits.filter((commit) => !seen.has(commit.hash)),
        ];
      });
      setHasMore(res.hasMore);
    } catch (err) {
      setListError(err instanceof Error ? err.message : t("gitStatusLoading"));
    }
  }, [commits.length, projectId, t]);

  const handleProjectionRequestFailure = useCallback(() => {
    setCompareToHead(false);
    setComparison(null);
    setLoadingComparison(false);
    if (compareToHead) setSelectedPath(null);
    onProjectionUnavailable();
  }, [compareToHead, onProjectionUnavailable]);

  const toggleComparison = useCallback(() => {
    if (compareToHead) {
      setCompareToHead(false);
      setComparison(null);
      setLoadingComparison(false);
      setSelectedPath(null);
      return;
    }
    if (!supportsProjections) {
      onProjectionUnavailable();
      return;
    }
    setCompareToHead(true);
    setSelectedPath(null);
    setMessageView(false);
  }, [compareToHead, onProjectionUnavailable, supportsProjections]);

  useEffect(() => {
    if (!selectedSha) {
      setDetail(null);
      setLoadingDetail(false);
      setDetailError(null);
      setSelectedPath(null);
      setMessageView(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    setDetail(null);
    setSelectedPath(null);
    setMessageView(false);
    api
      .getGitCommit(projectId, selectedSha)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setLoadingDetail(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailError(
          err instanceof Error ? err.message : t("gitStatusLoading"),
        );
        setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedSha, t]);

  useEffect(() => {
    if (!compareToHead || !selectedSha || !supportsProjections) {
      setComparison(null);
      setLoadingComparison(false);
      if (compareToHead && !supportsProjections) {
        handleProjectionRequestFailure();
      }
      return;
    }
    let cancelled = false;
    setComparison(null);
    setLoadingComparison(true);
    api
      .getGitComparison(projectId, selectedSha)
      .then((result) => {
        if (cancelled) return;
        setComparison(result);
        setLoadingComparison(false);
      })
      .catch(() => {
        if (cancelled) return;
        handleProjectionRequestFailure();
      });
    return () => {
      cancelled = true;
    };
  }, [
    compareToHead,
    handleProjectionRequestFailure,
    projectId,
    selectedSha,
    supportsProjections,
  ]);

  const selectedFiles = useMemo(
    () => (compareToHead ? (comparison?.files ?? []) : (detail?.files ?? [])),
    [compareToHead, comparison?.files, detail?.files],
  );

  useEffect(() => {
    if (!isWideScreen) return;
    setSelectedPath((current) =>
      current && selectedFiles.some((file) => file.path === current)
        ? current
        : (selectedFiles[0]?.path ?? null),
    );
  }, [isWideScreen, selectedFiles]);

  const selectedFile: GitFileChange | null = selectedPath
    ? (selectedFiles.find((file) => file.path === selectedPath) ?? null)
    : null;
  const source =
    selectedSha && compareToHead && comparison
      ? ({
          kind: "comparison",
          baseSha: comparison.baseSha,
          headSha: comparison.headSha,
        } as const)
      : selectedSha
        ? ({ kind: "commit", sha: selectedSha } as const)
        : undefined;
  const diffFileKey =
    selectedSha && selectedFile
      ? compareToHead && comparison
        ? `${comparison.baseSha}:${comparison.headSha}:${selectedFile.path}`
        : `${selectedSha}:${selectedFile.path}`
      : null;
  const selectedIndex = selectedKey ? displayedKeys.indexOf(selectedKey) : -1;
  const newerKey =
    selectedIndex > 0 ? displayedKeys[selectedIndex - 1] : undefined;
  const olderKey =
    selectedIndex >= 0 && selectedIndex < displayedKeys.length - 1
      ? displayedKeys[selectedIndex + 1]
      : undefined;
  const selectedCommit = selectedSha
    ? displayedCommits.find((commit) => commit.hash === selectedSha)
    : undefined;

  return {
    commits,
    displayedCommits,
    displayedKeys,
    hasMore,
    loadingList,
    listError,
    loadMore,
    searchQuery,
    setSearchQuery,
    searchIndexRequested,
    setSearchIndexRequested,
    searchActive,
    searchIndex,
    selectedKey,
    setSelectedKey,
    selectedIsWorkingTree,
    selectedSha,
    selectedCommit,
    showWorkingTreeRevision,
    detail,
    loadingDetail,
    detailError,
    selectedPath,
    setSelectedPath,
    selectedFiles,
    selectedFile,
    compareToHead,
    loadingComparison,
    toggleComparison,
    handleProjectionRequestFailure,
    messageView,
    setMessageView,
    source,
    diffFileKey,
    newerKey,
    olderKey,
  };
}
