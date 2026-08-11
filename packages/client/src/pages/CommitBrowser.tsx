import type { GitCommitDetail, GitStatusInfo } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { ResizableSourceColumns } from "../components/ResizableSourceColumns";
import { SourceFileHeaderActions } from "../components/SourceFileHeaderActions";
import { Modal } from "../components/ui/Modal";
import { useCommitReadWatermark } from "../hooks/useCommitReadWatermark";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import {
  isEditableKeyboardTarget,
  useSourceSearchShortcut,
} from "../hooks/useSourceKeyboard";
import { CommitFilesPane, formatCommitDateTime } from "./CommitFilesPane";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffPreviewHandle,
} from "./GitStatusDiffPreview";
import { CommitRevisionPane } from "./CommitRevisionPane";
import { useCommitBrowserModel } from "./useCommitBrowserModel";
import { WorkingTreeBrowser } from "./WorkingTreeBrowser";
import type { TranslationFn } from "../i18n";

const NOOP = () => {};

/**
 * The responsive commit history: commits · changed files · diff. Wide screens
 * expose all three panes; narrow screens drill from the list into one
 * selected commit's files so selection never renders below the full history.
 */
export function CommitBrowser({
  projectId,
  status,
  isWideScreen,
  initialSha,
  initialPath,
  onBlameFile,
  captureReviewProjections = false,
  supportsProjections = false,
  supportsLastEditor = false,
  ignoreWhitespace = false,
  onToggleIgnoreWhitespace = NOOP,
  onProjectionUnavailable = NOOP,
  t,
}: {
  projectId: string;
  /** Supplies the pinned Working tree revision without a second git model. */
  status?: GitStatusInfo;
  isWideScreen: boolean;
  /** Direct commit selection, e.g. from an asynchronously populated blame hash. */
  initialSha?: string;
  /** Direct file selection within the initial commit. */
  initialPath?: string;
  /** Bridge a commit file to its blame-at-HEAD view (the files tab). */
  onBlameFile?: (path: string) => void;
  captureReviewProjections?: boolean;
  supportsProjections?: boolean;
  supportsLastEditor?: boolean;
  ignoreWhitespace?: boolean;
  onToggleIgnoreWhitespace?: () => void;
  onProjectionUnavailable?: () => void;
  t: TranslationFn;
}) {
  const diffPreviewRef = useRef<GitDiffPreviewHandle>(null);
  const browserRef = useRef<HTMLDivElement>(null);
  const detailColumnRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileListScrollTopRef = useRef(0);
  const restoreMobileListScrollRef = useRef(false);
  useSourceSearchShortcut(searchInputRef);
  const {
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
  } = useCommitBrowserModel({
    projectId,
    status,
    isWideScreen,
    initialSha,
    initialPath,
    supportsProjections,
    onProjectionUnavailable,
    t,
  });

  const { pending, siteStates } = useProjectReviewComments(
    projectId,
    captureReviewProjections,
  );
  const readState = useCommitReadWatermark(projectId);

  // Pending review-comment counts for the row badges: per commit sha (commit
  // list) and, within the selected commit, per file path (file list).
  const commentCountBySha = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (comment.anchor.revision.kind === "sha") {
        const { sha } = comment.anchor.revision;
        counts.set(sha, (counts.get(sha) ?? 0) + 1);
      }
    }
    return counts;
  }, [pending]);
  const workingTreeCommentCount = useMemo(
    () =>
      pending.filter(
        (comment) => comment.anchor.revision.kind === "uncommitted",
      ).length,
    [pending],
  );
  const fileCommentCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pending) {
      if (
        comment.anchor.revision.kind === "sha" &&
        comment.anchor.revision.sha === selectedSha
      ) {
        counts.set(
          comment.anchor.path,
          (counts.get(comment.anchor.path) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [pending, selectedSha]);
  const reviewStatesByPath = useMemo(() => {
    const states = new Map<string, typeof siteStates>();
    for (const state of siteStates) {
      const current = states.get(state.path);
      if (current) current.push(state);
      else states.set(state.path, [state]);
    }
    return states;
  }, [siteStates]);

  const openRevision = useCallback(
    (key: string) => {
      if (!isWideScreen) {
        const scroller = browserRef.current?.closest<HTMLElement>(
          ".page-scroll-container",
        );
        mobileListScrollTopRef.current = scroller?.scrollTop ?? 0;
      }
      setSelectedKey(key);
    },
    [isWideScreen, setSelectedKey],
  );

  // Selected-file actions, shown in the diff pane header (the file banner)
  // instead of on every hovered row.
  const fileActions = selectedFile ? (
    <SourceFileHeaderActions
      path={selectedFile.path}
      onBlameFile={onBlameFile}
      t={t}
    />
  ) : null;

  const closeMobileDetail = useCallback(() => {
    restoreMobileListScrollRef.current = true;
    setSelectedKey(null);
    setSelectedPath(null);
    setMessageView(false);
  }, [setMessageView, setSelectedKey, setSelectedPath]);
  useMobileCommitDetailHistory(
    !isWideScreen && selectedKey !== null,
    closeMobileDetail,
  );

  const handleMobileBack = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      (window.history.state as { yaCommitDetail?: boolean } | null)
        ?.yaCommitDetail
    ) {
      window.history.back();
      return;
    }
    closeMobileDetail();
  }, [closeMobileDetail]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isEditableKeyboardTarget(event.target) ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }
      if (!isWideScreen && selectedKey) {
        event.preventDefault();
        handleMobileBack();
        return;
      }
      if (searchQuery) {
        event.preventDefault();
        setSearchQuery("");
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleMobileBack,
    isWideScreen,
    searchQuery,
    selectedKey,
    setSearchQuery,
  ]);

  useLayoutEffect(() => {
    if (isWideScreen) return;
    const scroller = browserRef.current?.closest<HTMLElement>(
      ".page-scroll-container",
    );
    if (selectedKey) {
      const detailTarget =
        detailColumnRef.current ??
        browserRef.current?.querySelector<HTMLElement>(
          ".working-tree-browser-history",
        );
      detailTarget?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (restoreMobileListScrollRef.current && scroller) {
      restoreMobileListScrollRef.current = false;
      scroller.scrollTop = mobileListScrollTopRef.current;
    }
  }, [isWideScreen, selectedKey]);

  return (
    <div className="commit-browser" ref={browserRef}>
      <ResizableSourceColumns
        layout="history"
        className="commit-browser-columns"
        t={t}
      >
        {(isWideScreen || !selectedKey) && (
          <CommitRevisionPane
            status={status}
            isWideScreen={isWideScreen}
            searchInputRef={searchInputRef}
            searchQuery={searchQuery}
            searchIndexRequested={searchIndexRequested}
            searchIndexing={searchIndex.indexing}
            indexedCount={searchIndex.indexedCount}
            totalCount={searchIndex.totalCount}
            searchError={searchIndex.error}
            searchActive={searchActive}
            displayedCommits={displayedCommits}
            displayedKeys={displayedKeys}
            selectedKey={selectedKey}
            selectedIsWorkingTree={selectedIsWorkingTree}
            showWorkingTreeRevision={showWorkingTreeRevision}
            loadingList={loadingList}
            listError={listError}
            hasMore={hasMore}
            workingTreeCommentCount={workingTreeCommentCount}
            commentCountBySha={commentCountBySha}
            isRead={readState.isRead}
            onSearchQueryChange={setSearchQuery}
            onSearchIndexRequested={() => setSearchIndexRequested(true)}
            onOpenRevision={openRevision}
            onFocusRevision={setSelectedKey}
            onLoadMore={() => {
              void loadMore();
            }}
            onMarkReadTo={readState.markReadTo}
            onMarkUnreadSince={readState.markUnreadSince}
            t={t}
          />
        )}

        {selectedIsWorkingTree && status && (
          <WorkingTreeBrowser
            projectId={projectId}
            status={status}
            isWideScreen={isWideScreen}
            embeddedInHistory
            onBackToRevisions={!isWideScreen ? handleMobileBack : undefined}
            revisionNavigation={
              <RevisionJump
                newerKey={newerKey}
                olderKey={olderKey}
                onSelect={openRevision}
                t={t}
              />
            }
            onBlameFile={onBlameFile}
            captureReviewProjections={captureReviewProjections}
            supportsLastEditor={supportsLastEditor}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={handleProjectionRequestFailure}
            t={t}
          />
        )}

        {selectedSha && (
          <CommitFilesPane
            columnRef={detailColumnRef}
            selectedSha={selectedSha}
            selectedCommit={selectedCommit}
            detail={detail}
            loading={loadingDetail || (compareToHead && loadingComparison)}
            detailError={detailError}
            compareToHead={compareToHead}
            isWideScreen={isWideScreen}
            messageView={messageView}
            selectedFiles={selectedFiles}
            selectedPath={selectedPath}
            fileCommentCount={fileCommentCount}
            reviewStatesByPath={reviewStatesByPath}
            revisionNavigation={
              <RevisionJump
                newerKey={newerKey}
                olderKey={olderKey}
                onSelect={openRevision}
                t={t}
              />
            }
            onBack={!isWideScreen ? handleMobileBack : undefined}
            onToggleComparison={toggleComparison}
            onShowMessage={() => setMessageView(true)}
            onFocusFile={(file) => {
              setSelectedPath(file.path);
              setMessageView(false);
            }}
            onFilteredSelectionChange={(file) => {
              setSelectedPath(file?.path ?? null);
              setMessageView(false);
            }}
            onActivateFile={(file) => {
              if (
                selectedPath === file.path &&
                !messageView &&
                diffPreviewRef.current?.jumpToNextHunk()
              ) {
                return;
              }
              setSelectedPath(file.path);
              setMessageView(false);
            }}
            onBlameFile={onBlameFile}
            onMarkReadTo={readState.markReadTo}
            onMarkUnreadSince={readState.markUnreadSince}
            t={t}
          />
        )}

        {isWideScreen &&
          (messageView && detail ? (
            <CommitMessageView detail={detail} t={t} />
          ) : selectedFile && source && diffFileKey ? (
            <GitDiffPreview
              ref={diffPreviewRef}
              file={selectedFile}
              fileKey={diffFileKey}
              projectId={projectId}
              source={source}
              captureReviewProjections={captureReviewProjections}
              headerActions={fileActions}
              ignoreWhitespace={ignoreWhitespace}
              onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
              onProjectionRequestFailure={handleProjectionRequestFailure}
              t={t}
            />
          ) : null)}
      </ResizableSourceColumns>

      {!isWideScreen && messageView && detail && (
        <Modal
          title={detail.shortHash}
          onClose={() => setMessageView(false)}
          closeOnBackGesture
        >
          <CommitMessageView detail={detail} t={t} />
        </Modal>
      )}

      {!isWideScreen &&
        !messageView &&
        selectedFile &&
        source &&
        diffFileKey && (
          <GitDiffModal
            file={selectedFile}
            fileKey={diffFileKey}
            projectId={projectId}
            source={source}
            captureReviewProjections={captureReviewProjections}
            headerActions={fileActions}
            ignoreWhitespace={ignoreWhitespace}
            onToggleIgnoreWhitespace={onToggleIgnoreWhitespace}
            onProjectionRequestFailure={handleProjectionRequestFailure}
            t={t}
            onClose={() => setSelectedPath(null)}
          />
        )}
    </div>
  );
}

function RevisionJump({
  newerKey,
  olderKey,
  onSelect,
  t,
}: {
  newerKey?: string;
  olderKey?: string;
  onSelect: (key: string) => void;
  t: TranslationFn;
}) {
  return (
    <span className="source-detail-jump">
      <button
        type="button"
        className="commit-jump-btn"
        title={t("sourceNewerCommit")}
        aria-label={t("sourceNewerCommit")}
        disabled={!newerKey}
        onClick={() => newerKey && onSelect(newerKey)}
      >
        <span className="commit-jump-glyph" aria-hidden="true">
          ↑
        </span>
        <span className="commit-jump-touch-label">
          {t("sourceNewerCommit")}
        </span>
      </button>
      <button
        type="button"
        className="commit-jump-btn"
        title={t("sourceOlderCommit")}
        aria-label={t("sourceOlderCommit")}
        disabled={!olderKey}
        onClick={() => olderKey && onSelect(olderKey)}
      >
        <span className="commit-jump-glyph" aria-hidden="true">
          ↓
        </span>
        <span className="commit-jump-touch-label">
          {t("sourceOlderCommit")}
        </span>
      </button>
    </span>
  );
}

function useMobileCommitDetailHistory(
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const priorState =
      (window.history.state as Record<string, unknown> | null) ?? {};
    window.history.pushState({ ...priorState, yaCommitDetail: true }, "");
    let dismissedByBack = false;
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { yaCommitDetail?: boolean } | null;
      // Returning from the nested mobile diff lands on the commit-detail
      // entry. Keep the revision detail open; the next Back closes it.
      if (state?.yaCommitDetail) return;
      dismissedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (
        !dismissedByBack &&
        (window.history.state as { yaCommitDetail?: boolean } | null)
          ?.yaCommitDetail
      ) {
        window.history.back();
      }
    };
  }, [open]);
}

/**
 * The selected commit's original-format message shown in the detail pane
 * (opened by clicking the commit body): the verbatim subject + body with its
 * hard line breaks preserved, plus the exact author date/time. Reuses the diff
 * pane's chrome so it slots into the same column.
 */
function CommitMessageView({
  detail,
  t,
}: {
  detail: GitCommitDetail;
  t: TranslationFn;
}) {
  const full = detail.body
    ? `${detail.subject}\n\n${detail.body}`
    : detail.subject;
  return (
    <section className="git-diff-preview-pane">
      <div className="git-diff-preview-header">
        <h3 className="git-diff-preview-title" title={detail.hash}>
          {detail.shortHash}
        </h3>
        <span className="commit-message-time">
          {formatCommitDateTime(detail.authorDate)}
        </span>
      </div>
      <div className="git-diff-preview-body">
        <div className="commit-message-view">
          <div className="commit-message-view-meta">
            {detail.authorName} · {t("sourceCommitMessage")}
          </div>
          <pre className="commit-message-full">{full}</pre>
        </div>
      </div>
    </section>
  );
}
