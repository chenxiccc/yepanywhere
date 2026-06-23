import type { GitCommitDetail as GitCommitDetailType, GitFileChange } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { BranchSelector } from "../components/BranchSelector";
import { FileTree } from "../components/FileTree";
import { FileTreeSearch } from "../components/FileTreeSearch";
import { FileViewer } from "../components/FileViewer";
import { GitCommitDetail, GitCommitFileTree } from "../components/GitCommitDetail";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { GitHistoryPanel } from "../components/GitHistoryPanel";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { useBranches } from "../hooks/useBranches";
import { useGitStatus } from "../hooks/useGitStatus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePanelResize } from "../hooks/usePanelResize";
import { useProject } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";

type MobileView =
  | { type: "file"; payload: { filePath: string } }
  | { type: "diff"; payload: { filePath: string; staged: boolean } }
  | { type: "commit"; payload: { commitHash: string } }
  | { type: "commitDiff"; payload: { commitHash: string; filePath: string } }
  | null;

/**
 * 源码/文件管理页面
 * Source file manager page — unified file tree, git changes, and history.
 *
 * 路由: /projects/:projectId/source
 * Route: /projects/:projectId/source
 */
export function SourceFilePage() {
  const { t } = useI18n();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { project } = useProject(projectId);
  const { gitStatus, loading: gitLoading } = useGitStatus(projectId);
  const {
    branches,
    currentBranch,
    loading: branchesLoading,
    checkout,
    createBranch,
  } = useBranches(projectId);
  const isMobile = useMediaQuery("(max-width: 767px)");

  // 标签页 / Active tab
  const [activeTab, setActiveTab] = useState<"files" | "changes" | "history">(
    "files",
  );

  // 搜索 / Search
  const [searchQuery, setSearchQuery] = useState("");

  // 桌面端：选中文件/Diff / Desktop: selected file/diff
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] =
    useState<GitFileChange | null>(null);

  // 提交详情 / Commit detail
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetailType | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);

  // 分栏宽度 / Split panel width
  const {
    width: leftPanelWidth,
    isResizing,
    resizeHandleProps,
  } = usePanelResize({
    initialWidth: 280,
    minWidth: 180,
    maxWidth: 560,
    storageKey: "source-file",
  });

  // 手机端：内容视图 / Mobile: content view
  const [mobileView, setMobileView] = useState<MobileView>(null);

  // 文件树刷新键（分支切换时递增）/ File tree refresh key (incremented on branch switch)
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);

  // 解析初始 hash / Parse initial hash
  useEffect(() => {
    if (!isMobile) return;
    const hash = window.location.hash;
    const fileMatch = hash.match(/^#file=(.+)$/);
    const diffMatch = hash.match(/^#diff=(.+)&staged=(\d)$/);
    const commitMatch = hash.match(/^#commit=(.+)$/);
    const commitDiffMatch = hash.match(/^#commitDiff=(.+)&file=(.+)$/);
    if (fileMatch) {
      const filePath = decodeURIComponent(fileMatch[1]!);
      setMobileView({ type: "file", payload: { filePath } });
    } else if (diffMatch) {
      const filePath = decodeURIComponent(diffMatch[1]!);
      const staged = diffMatch[2] === "1";
      setMobileView({ type: "diff", payload: { filePath, staged } });
    } else if (commitDiffMatch) {
      const commitHash = decodeURIComponent(commitDiffMatch[1]!);
      const filePath = decodeURIComponent(commitDiffMatch[2]!);
      setMobileView({ type: "commitDiff", payload: { commitHash, filePath } });
    } else if (commitMatch) {
      const commitHash = decodeURIComponent(commitMatch[1]!);
      setMobileView({ type: "commit", payload: { commitHash } });
    }
  }, [isMobile]);

  // 监听 popstate / Handle popstate
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (!isMobile) return;
      // 如果有 state，按 state 恢复 / Restore from state if available
      if (event.state?.type) {
        const state = event.state as { type: string; [key: string]: unknown };
        if (state.type === "commitDiff" && state.commitHash && state.filePath) {
          setMobileView({
            type: "commitDiff",
            payload: { commitHash: state.commitHash as string, filePath: state.filePath as string },
          });
          return;
        }
        if (state.type === "commit" && state.commitHash) {
          setMobileView({ type: "commit", payload: { commitHash: state.commitHash as string } });
          return;
        }
        if (state.type === "diff" && state.path) {
          setMobileView({ type: "diff", payload: { filePath: state.path as string, staged: (state.staged as boolean) ?? false } });
          return;
        }
        if (state.type === "file" && state.path) {
          setMobileView({ type: "file", payload: { filePath: state.path as string } });
          return;
        }
      }
      // 没有 state 时回退到列表 / No state means go back to list
      setMobileView(null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile]);

  // 点击文件 / File click handler
  const handleFileClick = useCallback(
    (filePath: string) => {
      if (isMobile) {
        const hash = `#file=${encodeURIComponent(filePath)}`;
        window.history.pushState({ type: "file", path: filePath }, "", hash);
        setMobileView({ type: "file", payload: { filePath } });
      } else {
        setSelectedFilePath(filePath);
      }
    },
    [isMobile],
  );

  // 点击 Git 变更 / Git change click handler
  const handleDiffClick = useCallback(
    (file: GitFileChange) => {
      if (isMobile) {
        const hash = `#diff=${encodeURIComponent(file.path)}&staged=${file.staged ? "1" : "0"}`;
        window.history.pushState(
          { type: "diff", path: file.path, staged: file.staged },
          "",
          hash,
        );
        setMobileView({
          type: "diff",
          payload: { filePath: file.path, staged: file.staged },
        });
      } else {
        setSelectedDiffFile(file);
      }
    },
    [isMobile],
  );

  // 点击提交历史 / Commit history click handler
  const handleCommitClick = useCallback(
    (hash: string) => {
      if (isMobile) {
        const hashParam = `#commit=${encodeURIComponent(hash)}`;
        window.history.pushState({ type: "commit", commitHash: hash }, "", hashParam);
        setMobileView({ type: "commit", payload: { commitHash: hash } });
      } else {
        setSelectedCommitHash(hash);
        setCommitDetail(null);
        setCommitDetailLoading(true);
        api.getGitCommit(projectId!, hash).then((data) => {
          setCommitDetail(data.commit);
          setCommitDetailLoading(false);
        }).catch(() => {
          setCommitDetailLoading(false);
        });
      }
    },
    [isMobile, projectId],
  );

  // 点击提交中的文件（手机端）/ Commit file click handler (mobile)
  const handleCommitFileClick = useCallback(
    (commitHash: string, filePath: string) => {
      const hashParam = `#commitDiff=${encodeURIComponent(commitHash)}&file=${encodeURIComponent(filePath)}`;
      window.history.pushState(
        { type: "commitDiff", commitHash, filePath },
        "",
        hashParam,
      );
      setMobileView({ type: "commitDiff", payload: { commitHash, filePath } });
    },
    [],
  );

  // 加载选中提交的详情（手机端 commit 视图）/ Load commit detail (mobile commit view)
  const mobileCommitDetail = useMobileCommitDetail(projectId, mobileView);

  // 手机端返回 / Mobile back
  // 如果通过 pushState 导航进来（有 state），则 back 回列表；否则直接清空视图
  // If navigated via pushState (has state), go back to list; otherwise just clear the view
  const handleMobileBack = useCallback(() => {
    if (window.history.state?.type) {
      window.history.back();
    } else {
      setMobileView(null);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // 分支切换后 / After branch change
  const handleBranchChanged = useCallback(() => {
    setSelectedFilePath(null);
    setSelectedDiffFile(null);
    setFileTreeRefreshKey((k) => k + 1);
  }, []);

  // 当变更列表变化时，清除不在列表中的已选 diff 文件
  // Clear selected diff file if it's no longer in the changes list
  useEffect(() => {
    if (!selectedDiffFile || !gitStatus) return;
    const stillExists = gitStatus.files.some(
      (f) => f.path === selectedDiffFile.path && f.staged === selectedDiffFile.staged,
    );
    if (!stillExists) {
      setSelectedDiffFile(null);
    }
  }, [gitStatus, selectedDiffFile]);

  // 项目切换 / Project change
  const handleProjectChange = useCallback(
    (p: { id: string }) => {
      navigate(`${basePath}/projects/${p.id}/source`);
    },
    [navigate, basePath],
  );

  const totalChanges = (gitStatus?.files.length || 0);

  // 手机端内容视图 / Mobile content view
  if (isMobile && mobileView) {
    if (mobileView.type === "commit") {
      return (
        <MainContent isWideScreen={isWideScreen}>
          <div className="source-file-mobile-view">
            <div className="source-file-mobile-header">
              <button
                type="button"
                className="source-file-mobile-back"
                onClick={handleMobileBack}
              >
                ← {t("sourceFileBack" as never)}
              </button>
              <span className="source-file-mobile-title">
                {mobileCommitDetail?.message ?? "..."}
              </span>
            </div>
            <div className="source-file-mobile-body">
              {mobileCommitDetail ? (
                <GitCommitDetail
                  projectId={projectId || ""}
                  detail={mobileCommitDetail}
                  mobile
                  onFileClick={(filePath) =>
                    handleCommitFileClick(mobileView.payload.commitHash, filePath)
                  }
                />
              ) : (
                <div className="git-history-loading">Loading…</div>
              )}
            </div>
          </div>
        </MainContent>
      );
    }

    if (mobileView.type === "commitDiff") {
      const title = mobileView.payload.filePath.split("/").pop() || "";
      return (
        <MainContent isWideScreen={isWideScreen}>
          <div className="source-file-mobile-view">
            <div className="source-file-mobile-header">
              <button
                type="button"
                className="source-file-mobile-back"
                onClick={handleMobileBack}
              >
                ← {t("sourceFileBack" as never)}
              </button>
              <span className="source-file-mobile-title">{title}</span>
            </div>
            <div className="source-file-mobile-body">
              <GitDiffPanel
                projectId={projectId || ""}
                file={{
                  path: mobileView.payload.filePath,
                  staged: false,
                  status: "M",
                  linesAdded: null,
                  linesDeleted: null,
                }}
                commitHash={mobileView.payload.commitHash}
              />
            </div>
          </div>
        </MainContent>
      );
    }

    const title =
      mobileView.type === "file"
        ? mobileView.payload.filePath.split("/").pop() || ""
        : mobileView.payload.filePath.split("/").pop() || "";

    return (
      <MainContent isWideScreen={isWideScreen}>
        <div className="source-file-mobile-view">
          <div className="source-file-mobile-header">
            <button
              type="button"
              className="source-file-mobile-back"
              onClick={handleMobileBack}
            >
              ← {t("sourceFileBack" as never)}
            </button>
            <span className="source-file-mobile-title">{title}</span>
          </div>
          <div className="source-file-mobile-body">
            {mobileView.type === "file" ? (
              <FileViewer
                projectId={projectId || ""}
                filePath={mobileView.payload.filePath}
                standalone
              />
            ) : mobileView.type === "diff" ? (
              <GitDiffPanel
                projectId={projectId || ""}
                file={{
                  path: mobileView.payload.filePath,
                  staged: mobileView.payload.staged,
                  status: mobileView.payload.staged ? "M" : "M",
                  linesAdded: null,
                  linesDeleted: null,
                }}
              />
            ) : null}
          </div>
        </div>
      </MainContent>
    );
  }

  if (!projectId) {
    return (
      <MainContent isWideScreen={isWideScreen}>
        <div className="error">No project selected</div>
      </MainContent>
    );
  }

  return (
    <MainContent isWideScreen={isWideScreen} className="source-file-main-content">
      <PageHeader
        title={project?.name ?? t("sourceFileTitle" as never)}
        titleElement={
          <div className="source-file-header-left">
            <ProjectSelector
              currentProjectId={projectId}
              currentProjectName={project?.name}
              onProjectChange={handleProjectChange}
            />
            <BranchSelector
              projectId={projectId}
              currentBranch={currentBranch}
              branches={branches}
              loading={branchesLoading}
              onBranchChanged={handleBranchChanged}
              onCheckout={checkout}
              onCreateBranch={createBranch}
            />
          </div>
        }
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner source-file-page-inner">
          {/* 标签栏 / Tab bar — always visible, matches left panel width on desktop */}
          <div className="source-file-tabs" style={isMobile ? undefined : { width: leftPanelWidth, flexShrink: 0 }}>
            <button
              type="button"
              className={`source-file-tab ${activeTab === "files" ? "active" : ""}`}
              onClick={() => setActiveTab("files")}
            >
              {t("sourceFileTabFiles" as never)}
            </button>
            <button
              type="button"
              className={`source-file-tab ${activeTab === "changes" ? "active" : ""}`}
              onClick={() => setActiveTab("changes")}
            >
              {t("sourceFileTabChanges" as never)}
              {totalChanges > 0 && (
                <span className="source-file-tab-badge">{totalChanges}</span>
              )}
            </button>
            <button
              type="button"
              className={`source-file-tab ${activeTab === "history" ? "active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              {t("sourceFileTabHistory" as never)}
            </button>
          </div>

          {/* 内容区 / Content area */}
          <div className="source-file-content">
            {/* 文件标签页 / Files tab */}
            {activeTab === "files" && (
              isMobile ? (
                <FileTree
                  projectId={projectId}
                  gitFiles={gitStatus?.files}
                  searchQuery={searchQuery}
                  selectedPath={null}
                  onFileClick={handleFileClick}
                  refreshKey={fileTreeRefreshKey}
                />
              ) : (
                <div className={`source-file-split ${isResizing ? "resizing" : ""}`}>
                  <div
                    className="source-file-left"
                    style={{ width: leftPanelWidth }}
                  >
                    <FileTreeSearch value={searchQuery} onChange={setSearchQuery} />
                    <FileTree
                      projectId={projectId}
                      gitFiles={gitStatus?.files}
                      searchQuery={searchQuery}
                      selectedPath={selectedFilePath}
                      onFileClick={handleFileClick}
                      refreshKey={fileTreeRefreshKey}
                    />
                  </div>
                  <div
                    className="source-file-resize-handle"
                    {...resizeHandleProps}
                  />
                  <div className="source-file-right">
                    {selectedFilePath ? (
                      <FileViewer
                        projectId={projectId}
                        filePath={selectedFilePath}
                        standalone={false}
                      />
                    ) : (
                      <div className="source-file-right-empty">
                        {t("sourceFileSelectFileHint" as never)}
                      </div>
                    )}
                  </div>
                </div>
              )
            )}

            {/* 变更标签页 / Changes tab */}
            {activeTab === "changes" && (
              isMobile ? (
                <div className="git-status">
                  {gitLoading ? (
                    <div className="loading">Loading…</div>
                  ) : gitStatus && !gitStatus.isGitRepo ? (
                    <div className="git-status-empty">Not a git repository</div>
                  ) : (
                    <GitCommitFileTree
                      files={gitStatus?.files || []}
                      selectedPath={null}
                      onFileClick={(filePath) => {
                        const file = gitStatus?.files.find((f) => f.path === filePath);
                        if (file) handleDiffClick(file);
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className={`source-file-split ${isResizing ? "resizing" : ""}`}>
                  <div
                    className="source-file-left"
                    style={{ width: leftPanelWidth }}
                  >
                    <div className="git-status">
                      {gitLoading ? (
                        <div className="loading">Loading…</div>
                      ) : gitStatus && !gitStatus.isGitRepo ? (
                        <div className="git-status-empty">Not a git repository</div>
                      ) : (
                        <GitCommitFileTree
                          files={gitStatus?.files || []}
                          selectedPath={selectedDiffFile?.path ?? null}
                          onFileClick={(filePath) => {
                            const file = gitStatus?.files.find((f) => f.path === filePath);
                            if (file) handleDiffClick(file);
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <div
                    className="source-file-resize-handle"
                    {...resizeHandleProps}
                  />
                  <div className="source-file-right">
                    {selectedDiffFile ? (
                      <GitDiffPanel
                        projectId={projectId}
                        file={selectedDiffFile}
                      />
                    ) : (
                      <div className="source-file-right-empty">
                        {t("sourceFileSelectDiffHint" as never)}
                      </div>
                    )}
                  </div>
                </div>
              )
            )}

            {/* 历史标签页 / History tab */}
            {activeTab === "history" && (
              isMobile ? (
                <GitHistoryPanel
                  projectId={projectId}
                  onCommitClick={handleCommitClick}
                />
              ) : (
                <div className={`source-file-split ${isResizing ? "resizing" : ""}`}>
                  <div
                    className="source-file-left"
                    style={{ width: leftPanelWidth }}
                  >
                    <GitHistoryPanel
                      projectId={projectId}
                      onCommitClick={handleCommitClick}
                      selectedHash={selectedCommitHash}
                    />
                  </div>
                  <div
                    className="source-file-resize-handle"
                    {...resizeHandleProps}
                  />
                  <div className="source-file-right">
                    {selectedCommitHash ? (
                      commitDetailLoading ? (
                        <div className="git-history-loading">Loading…</div>
                      ) : commitDetail ? (
                        <GitCommitDetail
                          projectId={projectId}
                          detail={commitDetail}
                        />
                      ) : (
                        <div className="git-history-error">Failed to load commit</div>
                      )
                    ) : (
                      <div className="source-file-right-empty">
                        {t("sourceFileSelectCommitHint" as never)}
                      </div>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      </main>
    </MainContent>
  );
}

/**
 * 手机端：加载提交详情 / Mobile: load commit detail.
 * 当 mobileView 为 commit 或 commitDiff 时加载对应提交的详情。
 */
function useMobileCommitDetail(
  projectId: string | undefined,
  mobileView: MobileView,
): GitCommitDetailType | null {
  const [detail, setDetail] = useState<GitCommitDetailType | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const commitHash =
      mobileView?.type === "commit" || mobileView?.type === "commitDiff"
        ? mobileView.payload.commitHash
        : null;
    if (!commitHash) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api.getGitCommit(projectId, commitHash).then((data) => {
      if (!cancelled) setDetail(data.commit);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, mobileView]);

  return detail;
}