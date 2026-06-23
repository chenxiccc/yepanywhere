import type { GitFileChange } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { BranchSelector } from "../components/BranchSelector";
import { FileTree } from "../components/FileTree";
import { FileTreeSearch } from "../components/FileTreeSearch";
import { FileViewer } from "../components/FileViewer";
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
    if (fileMatch) {
      const filePath = decodeURIComponent(fileMatch[1]!);
      setMobileView({ type: "file", payload: { filePath } });
    } else if (diffMatch) {
      const filePath = decodeURIComponent(diffMatch[1]!);
      const staged = diffMatch[2] === "1";
      setMobileView({ type: "diff", payload: { filePath, staged } });
    }
  }, [isMobile]);

  // 监听 popstate / Handle popstate
  useEffect(() => {
    const handlePopState = () => {
      if (isMobile && mobileView !== null) {
        setMobileView(null);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile, mobileView]);

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

  // 手机端返回 / Mobile back
  const handleMobileBack = useCallback(() => {
    window.history.back();
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

  // Git 变更文件分组 / Group git files
  const stagedFiles = useMemo(
    () => gitStatus?.files.filter((f) => f.staged) || [],
    [gitStatus],
  );
  const unstagedFiles = useMemo(
    () => gitStatus?.files.filter((f) => !f.staged && f.status !== "?") || [],
    [gitStatus],
  );
  const untrackedFiles = useMemo(
    () => gitStatus?.files.filter((f) => f.status === "?") || [],
    [gitStatus],
  );
  const totalChanges = (gitStatus?.files.length || 0);

  // 手机端内容视图 / Mobile content view
  if (isMobile && mobileView) {
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
                    <>
                      {stagedFiles.length > 0 && (
                        <GitFileSection
                          title="Staged"
                          files={stagedFiles}
                          onFileClick={handleDiffClick}
                        />
                      )}
                      {unstagedFiles.length > 0 && (
                        <GitFileSection
                          title="Changes"
                          files={unstagedFiles}
                          onFileClick={handleDiffClick}
                        />
                      )}
                      {untrackedFiles.length > 0 && (
                        <GitFileSection
                          title="Untracked"
                          files={untrackedFiles}
                          onFileClick={handleDiffClick}
                        />
                      )}
                    </>
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
                        <>
                          {stagedFiles.length > 0 && (
                            <GitFileSection
                              title="Staged"
                              files={stagedFiles}
                              onFileClick={handleDiffClick}
                            />
                          )}
                          {unstagedFiles.length > 0 && (
                            <GitFileSection
                              title="Changes"
                              files={unstagedFiles}
                              onFileClick={handleDiffClick}
                            />
                          )}
                          {untrackedFiles.length > 0 && (
                            <GitFileSection
                              title="Untracked"
                              files={untrackedFiles}
                              onFileClick={handleDiffClick}
                            />
                          )}
                        </>
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
              <div className="source-file-full-panel">
                <GitHistoryPanel projectId={projectId} />
              </div>
            )}
          </div>
        </div>
      </main>
    </MainContent>
  );
}

/**
 * Git 文件分组区 / Git file section (staged/unstaged/untracked).
 * 复用自 GitStatusPage 的 GitFileSection 逻辑
 * Reused from GitStatusPage's GitFileSection logic.
 */
function GitFileSection({
  title,
  files,
  onFileClick,
}: {
  title: string;
  files: GitFileChange[];
  onFileClick: (file: GitFileChange) => void;
}) {
  return (
    <div className="git-file-section">
      <h3 className="git-file-section-title">
        {title} <span className="git-file-count">({files.length})</span>
      </h3>
      <ul className="git-file-list">
        {files.map((file) => (
          <GitFileItem
            key={`${file.path}-${file.staged}`}
            file={file}
            onClick={onFileClick}
          />
        ))}
      </ul>
    </div>
  );
}

function GitFileItem({
  file,
  onClick,
}: {
  file: GitFileChange;
  onClick: (file: GitFileChange) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav not needed for file list
    <li
      className="git-file-item git-file-item-clickable"
      onClick={() => onClick(file)}
    >
      <span
        className={`git-status-badge git-status-${file.status.toLowerCase()}`}
      >
        {file.status}
      </span>
      <span className="git-file-path">
        {file.origPath ? (
          <>
            {file.origPath} → {file.path}
          </>
        ) : (
          file.path
        )}
      </span>
      {(file.linesAdded !== null || file.linesDeleted !== null) && (
        <span className="git-line-counts">
          {file.linesAdded !== null && (
            <span className="git-lines-added">+{file.linesAdded}</span>
          )}
          {file.linesDeleted !== null && (
            <span className="git-lines-deleted">-{file.linesDeleted}</span>
          )}
        </span>
      )}
    </li>
  );
}