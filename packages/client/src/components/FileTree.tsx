import type { FileNode, GitFileChange } from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";

const FILE_ICONS: Record<string, string> = {
  ts: "📘", tsx: "📘", js: "📒", jsx: "📒", json: "📋",
  html: "🌐", css: "🎨", md: "📝", py: "🐍", rs: "🦀",
  go: "🔷", java: "☕", sh: "⚡", yml: "⚙️", yaml: "⚙️",
  toml: "⚙️", svg: "🖼️", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️",
  ico: "🖼️", webp: "🖼️", mjs: "📒", cjs: "📒",
  scss: "🎨", less: "🎨", sass: "🎨", xml: "📋", sql: "🗄️",
  rb: "💎", php: "🐘", swift: "🍎", kt: "💜", dart: "🎯",
  vue: "💚", svelte: "🧡", lock: "🔒", gitignore: "🙈",
  env: "🔑", dockerfile: "🐳", makefile: "🔨", nix: "❄️",
};
const DIR_ICON_OPEN = "📂";
const DIR_ICON_CLOSED = "📁";
const FILE_ICON_DEFAULT = "📄";

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || FILE_ICON_DEFAULT;
}

type GitStatusChar = "M" | "A" | "D" | "?" | "R" | "U";

interface FileTreeProps {
  projectId: string;
  /** Git 状态文件列表，用于标记 / Git status files for marking */
  gitFiles?: GitFileChange[];
  /** 搜索查询 / Search query */
  searchQuery?: string;
  /** 当前选中的文件路径 / Currently selected file path */
  selectedPath?: string | null;
  /** 点击文件回调 / File click callback */
  onFileClick: (filePath: string) => void;
  className?: string;
  /** 外部刷新键，递增时全量刷新根节点 / External refresh key, triggers full root reload */
  refreshKey?: number;
}

/**
 * 文件树组件，支持懒加载子目录、搜索过滤、Git 状态标记
 * File tree component with lazy-loaded subdirectories, search filtering, and Git status markers.
 */
export const FileTree = memo(function FileTree({
  projectId,
  gitFiles,
  searchQuery,
  selectedPath,
  onFileClick,
  className,
  refreshKey,
}: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childCache, setChildCache] = useState<Map<string, FileNode[]>>(
    new Map(),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());
  const [rootLoading, setRootLoading] = useState(true);
  const [rootError, setRootError] = useState<string | null>(null);

  // 加载根目录 / Load root directory
  const loadRoot = useCallback(async () => {
    setRootLoading(true);
    setRootError(null);
    try {
      const data = await api.listDirectory(projectId);
      setRootNodes(data.children);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to load directory");
    } finally {
      setRootLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot, refreshKey]);

  // 页面可见时刷新已展开目录 / Refresh expanded directories on visibility change
  const refreshExpandedDirectories = useCallback(async () => {
    const paths = [...expandedPaths];
    if (paths.length === 0) return;
    const newCache = new Map(childCache);
    const newErrorPaths = new Map(errorPaths);

    await Promise.all(
      paths.map(async (dirPath) => {
        try {
          const data = await api.listDirectory(projectId, dirPath);
          newCache.set(dirPath, data.children);
          newErrorPaths.delete(dirPath);
        } catch (err) {
          newErrorPaths.set(
            dirPath,
            err instanceof Error ? err.message : "Failed to load",
          );
        }
      }),
    );

    setChildCache(newCache);
    setErrorPaths(newErrorPaths);
  }, [expandedPaths, childCache, errorPaths, projectId]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshExpandedDirectories();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [refreshExpandedDirectories]);

  // 从 gitFiles 构建状态映射 / Build status map from gitFiles
  const gitStatusMap = useMemo(() => {
    const map = new Map<string, GitStatusChar>();
    if (!gitFiles) return map;
    for (const f of gitFiles) {
      map.set(f.path, f.status as GitStatusChar);
    }
    return map;
  }, [gitFiles]);

  // 检查目录是否包含变更文件 / Check if directory contains changed files
  const dirHasChanges = useCallback(
    (dirPath: string): boolean => {
      const prefix = `${dirPath}/`;
      for (const path of gitStatusMap.keys()) {
        if (path.startsWith(prefix)) return true;
      }
      return false;
    },
    [gitStatusMap],
  );

  // 懒加载子目录 / Lazily load subdirectory children
  const loadChildren = useCallback(
    async (dirPath: string) => {
      if (childCache.has(dirPath) || loadingPaths.has(dirPath)) return;

      setLoadingPaths((prev) => new Set(prev).add(dirPath));
      try {
        const data = await api.listDirectory(projectId, dirPath);
        setChildCache((prev) => new Map(prev).set(dirPath, data.children));
        setErrorPaths((prev) => {
          const next = new Map(prev);
          next.delete(dirPath);
          return next;
        });
      } catch (err) {
        setErrorPaths((prev) =>
          new Map(prev).set(
            dirPath,
            err instanceof Error ? err.message : "Failed to load",
          ),
        );
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [childCache, loadingPaths, projectId],
  );

  // 切换展开/折叠 / Toggle expand/collapse
  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          // 触发懒加载 / Trigger lazy load
          loadChildren(dirPath);
        }
        return next;
      });
    },
    [loadChildren],
  );

  // 搜索过滤 / Search filtering
  const filterNodes = useCallback(
    (nodes: FileNode[]): { nodes: FileNode[]; matchedPaths: Set<string> } => {
      if (!searchQuery) return { nodes, matchedPaths: new Set() };
      const q = searchQuery.toLowerCase();
      const matchedPaths = new Set<string>();

      const filter = (items: FileNode[]): FileNode[] => {
        return items
          .map((item) => {
            const nameMatch = item.name.toLowerCase().includes(q);
            if (item.isDirectory) {
              const children = childCache.get(item.path) || [];
              const filteredChildren = filter(children);
              if (nameMatch || filteredChildren.length > 0) {
                matchedPaths.add(item.path);
                return { ...item };
              }
              return null;
            }
            if (nameMatch) {
              matchedPaths.add(item.path);
              return item;
            }
            return null;
          })
          .filter((n): n is FileNode => n !== null);
      };

      return { nodes: filter(nodes), matchedPaths };
    },
    [searchQuery, childCache],
  );

  // 自动展开搜索匹配的目录 / Auto-expand directories matching search
  useEffect(() => {
    if (!searchQuery) return;
    const { matchedPaths } = filterNodes(rootNodes);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const p of matchedPaths) {
        next.add(p);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const { nodes: filteredRootNodes } = useMemo(
    () => filterNodes(rootNodes),
    [filterNodes, rootNodes],
  );

  return (
    <div className={`file-tree ${className ?? ""}`}>
      {rootLoading ? (
        <div className="file-tree-loading">Loading…</div>
      ) : rootError ? (
        <div className="file-tree-error">
          {rootError}
          <button
            type="button"
            className="file-tree-retry-btn"
            onClick={loadRoot}
          >
            Retry
          </button>
        </div>
      ) : filteredRootNodes.length === 0 ? (
        <div className="file-tree-empty">目录为空</div>
      ) : (
        filteredRootNodes.map((node) => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={0}
            expandedPaths={expandedPaths}
            childCache={childCache}
            loadingPaths={loadingPaths}
            errorPaths={errorPaths}
            gitStatusMap={gitStatusMap}
            dirHasChanges={dirHasChanges}
            selectedPath={selectedPath ?? null}
            onFileClick={onFileClick}
            onToggleExpand={toggleExpand}
            onRetryLoad={loadChildren}
          />
        ))
      )}
    </div>
  );
});

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  expandedPaths: Set<string>;
  childCache: Map<string, FileNode[]>;
  loadingPaths: Set<string>;
  errorPaths: Map<string, string>;
  gitStatusMap: Map<string, GitStatusChar>;
  dirHasChanges: (dirPath: string) => boolean;
  selectedPath: string | null;
  onFileClick: (filePath: string) => void;
  onToggleExpand: (dirPath: string) => void;
  onRetryLoad: (dirPath: string) => void;
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  expandedPaths,
  childCache,
  loadingPaths,
  errorPaths,
  gitStatusMap,
  dirHasChanges,
  selectedPath,
  onFileClick,
  onToggleExpand,
  onRetryLoad,
}: FileTreeItemProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isLoading = loadingPaths.has(node.path);
  const error = errorPaths.get(node.path);
  const children = childCache.get(node.path) || [];
  const isSelected = selectedPath === node.path;
  const gitStatus = gitStatusMap.get(node.path);

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggleExpand(node.path);
    } else {
      onFileClick(node.path);
    }
  }, [node.isDirectory, node.path, onToggleExpand, onFileClick]);

  const handleRetry = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRetryLoad(node.path);
    },
    [node.path, onRetryLoad],
  );

  return (
    <div className="file-tree-item-wrapper">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled by parent */}
      <div
        className={`file-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={handleClick}
        title={node.isSymlink && node.symlinkTarget ? `${node.path} → ${node.symlinkTarget}` : node.path}
      >
        <div className="file-tree-row">
          {/* 展开/折叠箭头 / Expand/collapse chevron */}
          {node.isDirectory ? (
            <span
              className={`file-tree-chevron ${isExpanded ? "expanded" : ""}`}
            >
              {isLoading ? "⏳" : "▶"}
            </span>
          ) : (
            <span className="file-tree-chevron-placeholder" />
          )}

          {/* 图标 / Icon */}
          <span className="file-tree-icon">
            {node.isDirectory
              ? isExpanded
                ? DIR_ICON_OPEN
                : DIR_ICON_CLOSED
              : getFileIcon(node.name)}
          </span>

          {/* 文件名 / File name */}
          <span className="file-tree-name">{node.name}</span>

          {/* Git 状态标记 / Git status badge */}
          {gitStatus && (
            <span className={`file-tree-git-badge git-status-${gitStatus.toLowerCase()}`}>
              {gitStatus}
            </span>
          )}
          {node.isDirectory && !gitStatus && dirHasChanges(node.path) && (
            <span className="file-tree-git-dot" title="Contains changes" />
          )}

          {/* 元信息 / Meta info */}
          {!node.isDirectory && (
            <span className="file-tree-meta">
              {node.isSymlink ? (
                <span className="file-tree-symlink-icon" title={node.symlinkTarget ? `${node.path} → ${node.symlinkTarget}` : node.path}>↗</span>
              ) : (
                node.size !== undefined && formatFileSize(node.size)
              )}
            </span>
          )}
        </div>
      </div>

      {/* 展开的子目录 / Expanded children */}
      {isExpanded && node.isDirectory && (
        <div className="file-tree-connector">
          {error ? (
            <div
              className="file-tree-error"
              style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
            >
              <span>{error}</span>
              <button
                type="button"
                className="file-tree-retry-btn"
                onClick={handleRetry}
              >
                Retry
              </button>
            </div>
          ) : isLoading ? (
            <div
              className="file-tree-loading"
              style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
            >
              …
            </div>
          ) : children.length === 0 ? (
            <div
              className="file-tree-empty"
              style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
            >
              （空）
            </div>
          ) : (
            children.map((child) => (
              <FileTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                childCache={childCache}
                loadingPaths={loadingPaths}
                errorPaths={errorPaths}
                gitStatusMap={gitStatusMap}
                dirHasChanges={dirHasChanges}
                selectedPath={selectedPath}
                onFileClick={onFileClick}
                onToggleExpand={onToggleExpand}
                onRetryLoad={onRetryLoad}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} mb`;
}