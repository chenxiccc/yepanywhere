import type { GitCommitDetail, GitFileChange } from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { useGitDiff } from "../hooks/useGitDiff";
import { GitDiffContent } from "./GitDiffContent";
import { CopyTextButton } from "./ui/CopyTextButton";

interface GitCommitDetailProps {
  projectId: string;
  detail: GitCommitDetail;
  /** 手机端模式：仅显示文件列表，不显示 diff / Mobile mode: only show file list, no diff */
  mobile?: boolean;
  /** 手机端文件点击回调 / Mobile file click callback */
  onFileClick?: (filePath: string) => void;
}

/**
 * 提交详情组件，显示提交信息 + 变更文件列表 + 文件 diff
 * Commit detail component — shows commit info, changed files, and file diff.
 */
export function GitCommitDetail({
  projectId,
  detail,
  mobile,
  onFileClick,
}: GitCommitDetailProps) {
  const { t } = useI18n();
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // 当前选中的文件对象 / Currently selected file object
  const selectedFile = useMemo(() => {
    if (!selectedFilePath) return null;
    return detail.files.find((f) => f.path === selectedFilePath) ?? null;
  }, [selectedFilePath, detail.files]);

  // 加载选中文件的 diff / Load diff for selected file
  const diffState = useGitDiff({
    projectId,
    file: selectedFile ?? { path: "", staged: false, status: "M", linesAdded: null, linesDeleted: null },
    commitHash: detail.hash,
  });

  const handleFileClick = useCallback(
    (filePath: string) => {
      if (mobile && onFileClick) {
        onFileClick(filePath);
      } else {
        setSelectedFilePath(filePath);
      }
    },
    [mobile, onFileClick],
  );

  return (
    <div className="git-commit-detail">
      {/* 顶部：提交信息 / Header: commit info */}
      <div className="git-commit-detail-header">
        {/* 1. 提交标题 + 复制按钮（紧贴文字）/ Commit message + copy button */}
        <div className="git-commit-detail-message">
          <span className="git-commit-detail-message-text">{detail.message}</span>
          <CopyTextButton
            text={detail.message}
            label={t("sourceFileCopyCommitMessage" as never)}
            className="git-commit-detail-copy-btn"
            copiedClassName="copied"
            copiedLabel={t("sourceFileCopyCommitMessage" as never)}
          />
        </div>

        {/* 2. Hash + 复制按钮 + 作者 + 时间 */}
        <div className="git-commit-detail-hash-row">
          <span className="git-commit-detail-hash-text">{detail.hash.slice(0, 7)}</span>
          <CopyTextButton
            text={detail.hash}
            label={t("sourceFileCopyCommitHash" as never)}
            className="git-commit-detail-copy-btn"
            copiedClassName="copied"
            copiedLabel={t("sourceFileCopyCommitHash" as never)}
          />
          <span className="git-commit-detail-author">{detail.author}</span>
          <span className="git-commit-detail-date">{formatCommitDate(detail.date)}</span>
        </div>

        {/* 3. 提交详细说明 / Commit body */}
        {detail.body && (
          <div className="git-commit-detail-body">
            <pre className="git-commit-detail-body-text">{detail.body}</pre>
          </div>
        )}

        {/* 4. 提交所属分支 / Branches */}
        {detail.branches.length > 0 && (
          <div className="git-commit-detail-branches">
            {detail.branches.map((b) => (
              <span key={b} className="git-commit-detail-branch-tag">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {b}
              </span>
            ))}
          </div>
        )}

        {/* 5. 变更汇总 / Change summary */}
        <div className="git-commit-detail-summary">
          <span className="git-commit-detail-summary-files">
            {detail.filesChanged} {t("sourceFileCommitFiles" as never)}
          </span>
          {detail.additions > 0 && (
            <span className="git-commit-detail-summary-added">+{detail.additions}</span>
          )}
          {detail.deletions > 0 && (
            <span className="git-commit-detail-summary-deleted">-{detail.deletions}</span>
          )}
        </div>
      </div>

      {/* 下方区域 / Bottom area */}
      <div className={mobile ? "git-commit-detail-files-full" : "git-commit-detail-split"}>
        {/* 左侧：变更文件列表 / Left: changed files */}
        <div className="git-commit-detail-files">
          <div className="git-commit-detail-files-title">
            {t("sourceFileCommitFiles" as never)} ({detail.files.length})
          </div>
          <GitCommitFileTree
            files={detail.files}
            selectedPath={selectedFilePath}
            onFileClick={handleFileClick}
          />
        </div>

        {/* 右侧：diff（桌面端）/ Right: diff (desktop only) */}
        {!mobile && (
          <div className="git-commit-detail-diff">
            {selectedFile ? (
              <GitDiffContent
                file={selectedFile}
                projectId={projectId}
                {...diffState}
              />
            ) : (
              <div className="source-file-right-empty">
                {t("sourceFileSelectDiffHint" as never)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 提交变更文件树，将扁平文件列表组织为可展开的文件夹树
 * Commit file tree — organizes flat file list into an expandable folder tree.
 */
interface GitCommitFileTreeProps {
  files: GitFileChange[];
  selectedPath: string | null;
  onFileClick: (filePath: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  file?: GitFileChange;
}

function GitCommitFileTree({ files, selectedPath, onFileClick }: GitCommitFileTreeProps) {
  // 构建文件夹树 / Build folder tree
  const root = useMemo(() => {
    const rootNode: TreeNode = { name: "", path: "", isDirectory: true, children: [] };

    for (const file of files) {
      const parts = file.path.split("/");
      let current = rootNode;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] ?? "";
        const isLast = i === parts.length - 1;
        const currentPath = parts.slice(0, i + 1).join("/");

        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            isDirectory: !isLast,
            children: [],
            file: isLast ? file : undefined,
          };
          current.children.push(child);
        }
        if (isLast) {
          child.file = file;
        }
        current = child;
      }
    }

    return rootNode;
  }, [files]);

  return (
    <div className="git-commit-file-tree">
      {root.children.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onFileClick={onFileClick}
          depth={0}
        />
      ))}
    </div>
  );
}

/** 单个树节点 / Single tree node */
function TreeNodeItem({
  node,
  selectedPath,
  onFileClick,
  depth,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onFileClick: (filePath: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);

  if (node.isDirectory) {
    return (
      <div className="git-commit-file-node">
        <div
          className={`git-commit-file-dir${expanded ? " expanded" : ""}`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(!expanded);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span className="git-commit-file-chevron">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="git-commit-file-icon">📁</span>
          <span className="git-commit-file-name">{node.name}</span>
        </div>
        {expanded &&
          node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onFileClick={onFileClick}
              depth={depth + 1}
            />
          ))}
      </div>
    );
  }

  // 文件节点 / File node
  const file = node.file;
  const statusClass = file ? `git-commit-file-status-${file.status.toLowerCase()}` : "";

  return (
    <div
      className={`git-commit-file-node git-commit-file-item${selectedPath === node.path ? " selected" : ""}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => onFileClick(node.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFileClick(node.path);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="git-commit-file-icon">📄</span>
      <span className="git-commit-file-name">{node.name}</span>
      {file && (
        <>
          <span className={`git-commit-file-status ${statusClass}`}>
            {file.status}
          </span>
          {(file.linesAdded !== null || file.linesDeleted !== null) && (
            <span className="git-commit-file-stats">
              {file.linesAdded !== null && (
                <span className="git-commit-file-added">+{file.linesAdded}</span>
              )}
              {file.linesDeleted !== null && (
                <span className="git-commit-file-deleted">-{file.linesDeleted}</span>
              )}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** 格式化提交日期为浏览器本地时间 / Format commit date to browser local time */
function formatCommitDate(isoDate: string): string {
  const d = new Date(isoDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${h}:${min}`;
}