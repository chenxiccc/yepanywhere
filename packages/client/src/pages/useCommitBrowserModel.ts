import type {
  GitCommitDetail,
  GitFileChange,
  GitInclusiveRevisionComparison,
  GitRecentCommit,
  GitRevisionComparison,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  initialPath,
  supportsInclusiveToHead,
  onProjectionUnavailable,
  t,
}: {
  projectId: string;
  status?: GitStatusInfo;
  isWideScreen: boolean;
  initialSha?: string;
  initialPath?: string;
  supportsInclusiveToHead: boolean;
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
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialPath ?? null,
  );
  const [compareToHead, setCompareToHead] = useState(false);
  const [comparison, setComparison] =
    useState<GitInclusiveRevisionComparison | null>(null);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [directComparison, setDirectComparison] =
    useState<GitRevisionComparison | null>(null);
  const [directComparisonFile, setDirectComparisonFile] =
    useState<GitFileChange | null>(null);
  const directComparisonRequestRef = useRef(0);
  const [messageView, setMessageView] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexRequested, setSearchIndexRequested] = useState(false);

  const searchActive = searchQuery.trim().length > 0;
  const searchIndex = useCommitSearchIndex(
    projectId,
    searchQuery,
    searchIndexRequested,
  );

  useEffect(() => {
    if (!isWideScreen && searchQuery.trim().length > 0) setSelectedKey(null);
  }, [isWideScreen, searchQuery]);
  const searchedOrRecentCommits = searchActive
    ? searchIndex.results.map((result) => result.commit)
    : commits;
  const commitSearchMatches = useMemo(
    () =>
      new Map(
        searchIndex.results.map((result) => [result.commit.hash, result.match]),
      ),
    [searchIndex.results],
  );
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
  // Working tree remains a real selectable revision even when its diff is
  // empty. A clean landing prefers the newest commit while retaining that
  // pinned revision as the explicit way back to the clean state.
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

  const defaultKey = status?.isClean
    ? (displayedCommits[0]?.hash ??
      (!loadingList ? WORKING_TREE_KEY : undefined))
    : displayedKeys[0];

  // Desktop opens the preferred revision. A clean Source Control landing does
  // the same on phone so it reaches the useful newest commit instead of an
  // empty state. Explicit and user-selected revisions remain authoritative.
  useEffect(() => {
    if (searchActive || (!isWideScreen && !status?.isClean) || !defaultKey) {
      return;
    }
    setSelectedKey((current) =>
      current &&
      (displayedKeys.includes(current) ||
        (initialSha !== undefined && current === initialSha))
        ? current
        : defaultKey,
    );
  }, [
    defaultKey,
    displayedKeys,
    initialSha,
    isWideScreen,
    searchActive,
    status?.isClean,
  ]);

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
    directComparisonRequestRef.current += 1;
    setDirectComparison(null);
    setDirectComparisonFile(null);
    setCompareToHead(false);
    setComparison(null);
    setLoadingComparison(false);
    onProjectionUnavailable();
  }, [onProjectionUnavailable]);

  const openDirectComparison = useCallback(
    async (file: GitFileChange) => {
      if (!selectedSha) return;
      const requestId = directComparisonRequestRef.current + 1;
      directComparisonRequestRef.current = requestId;
      setCompareToHead(false);
      setComparison(null);
      setSelectedPath(file.path);
      setMessageView(false);
      try {
        const result = await api.getGitComparison(projectId, selectedSha);
        if (requestId !== directComparisonRequestRef.current) return;
        const comparedFile = result.files.find(
          (candidate) =>
            candidate.path === file.path || candidate.origPath === file.path,
        );
        setSelectedPath(comparedFile?.path ?? file.path);
        setDirectComparison(result);
        setDirectComparisonFile(
          comparedFile ?? {
            ...file,
            status: "M",
            staged: false,
            linesAdded: null,
            linesDeleted: null,
          },
        );
      } catch {
        if (requestId !== directComparisonRequestRef.current) return;
        setDirectComparison(null);
        setDirectComparisonFile(null);
        onProjectionUnavailable();
      }
    },
    [onProjectionUnavailable, projectId, selectedSha],
  );

  const toggleComparison = useCallback(() => {
    directComparisonRequestRef.current += 1;
    setDirectComparison(null);
    setDirectComparisonFile(null);
    if (compareToHead) {
      setCompareToHead(false);
      setComparison(null);
      setLoadingComparison(false);
      return;
    }
    if (!supportsInclusiveToHead) {
      onProjectionUnavailable();
      return;
    }
    setCompareToHead(true);
    setLoadingComparison(true);
    setMessageView(false);
  }, [compareToHead, onProjectionUnavailable, supportsInclusiveToHead]);

  useEffect(() => {
    directComparisonRequestRef.current += 1;
    setDirectComparison(null);
    setDirectComparisonFile(null);
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
    setSelectedPath(initialPath ?? null);
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
  }, [initialPath, projectId, selectedSha, t]);

  useEffect(() => {
    if (!compareToHead || !selectedSha || !supportsInclusiveToHead) {
      setComparison(null);
      setLoadingComparison(false);
      if (compareToHead && !supportsInclusiveToHead) {
        handleProjectionRequestFailure();
      }
      return;
    }
    let cancelled = false;
    setComparison(null);
    setLoadingComparison(true);
    api
      .getGitInclusiveComparison(projectId, selectedSha)
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
    supportsInclusiveToHead,
  ]);

  const selectedFiles = useMemo(
    () => (compareToHead ? (comparison?.files ?? []) : (detail?.files ?? [])),
    [compareToHead, comparison?.files, detail?.files],
  );

  useEffect(() => {
    if (compareToHead && loadingComparison) return;
    const linkedFile = initialPath
      ? selectedFiles.find(
          (file) => file.path === initialPath || file.origPath === initialPath,
        )
      : undefined;
    if (!isWideScreen && !linkedFile) return;
    setSelectedPath((current) => {
      const retainedFile = current
        ? selectedFiles.find(
            (file) => file.path === current || file.origPath === current,
          )
        : undefined;
      return (
        linkedFile?.path ?? retainedFile?.path ?? selectedFiles[0]?.path ?? null
      );
    });
  }, [
    compareToHead,
    initialPath,
    isWideScreen,
    loadingComparison,
    selectedFiles,
  ]);

  useEffect(() => {
    if (directComparisonFile && directComparisonFile.path !== selectedPath) {
      setDirectComparison(null);
      setDirectComparisonFile(null);
    }
  }, [directComparisonFile, selectedPath]);

  const ordinarySelectedFile: GitFileChange | null = selectedPath
    ? (selectedFiles.find((file) => file.path === selectedPath) ?? null)
    : null;
  const selectedFile = directComparisonFile ?? ordinarySelectedFile;
  const source =
    selectedSha && directComparison && directComparisonFile
      ? ({
          kind: "comparison",
          baseSha: directComparison.baseSha,
          headSha: directComparison.headSha,
        } as const)
      : selectedSha && compareToHead && comparison
        ? ({
            kind: "inclusive-comparison",
            baseSha: comparison.baseSha,
            headSha: comparison.headSha,
          } as const)
        : selectedSha
          ? ({ kind: "commit", sha: selectedSha } as const)
          : undefined;
  const diffFileKey =
    selectedSha && selectedFile
      ? directComparison && directComparisonFile
        ? `tree:${directComparison.baseSha}:${directComparison.headSha}:${selectedFile.path}`
        : compareToHead && comparison
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
    commitSearchMatches,
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
    openDirectComparison,
    handleProjectionRequestFailure,
    messageView,
    setMessageView,
    source,
    diffFileKey,
    newerKey,
    olderKey,
  };
}
