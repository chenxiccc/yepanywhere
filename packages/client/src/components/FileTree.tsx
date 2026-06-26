import type { FileNode } from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { useLongPressContextMenu } from "../hooks/useLongPressContextMenu";
import { FileContextMenu } from "./git-status/FileContextMenu";
import type { FileContextMenuState } from "./git-status/FileContextMenu";

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
const FILE_ICON_DEFAULT = "📄";

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || FILE_ICON_DEFAULT;
}

interface FileTreeProps {
  projectId: string;
  /** 搜索查询 / Search query */
  searchQuery?: string;
  /** 当前选中的文件路径 / Currently selected file path */
  selectedPath?: string | null;
  /** 点击文件回调 / File click callback */
  onFileClick: (filePath: string) => void;
  className?: string;
  /** 外部刷新键，递增时全量刷新根节点 / External refresh key, triggers full root reload */
  refreshKey?: number;
  /** i18n 翻译函数 / i18n translate function */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** 自定义标签，默认使用 gitStatus 命名空间的 key / Custom labels, default to gitStatus namespace keys */
  labels?: {
    loading?: string;
    retry?: string;
    empty?: string;
    loadingShort?: string;
    emptyDir?: string;
  };
  /** 项目根目录绝对路径，用于拼接绝对路径 / Project root absolute path */
  projectPath?: string;
  /** 重命名文件回调 / Rename file callback */
  onRenameFile?: (path: string, name: string) => void;
  /** 删除文件回调 / Delete file callback */
  onDeleteFile?: (path: string, name: string, isDirectory: boolean) => void;
}

/**
 * 文件树组件，支持懒加载子目录、搜索过滤
 * File tree component with lazy-loaded subdirectories and search filtering.
 */
export const FileTree = memo(function FileTree({
  projectId,
  searchQuery,
  selectedPath,
  onFileClick,
  className,
  refreshKey,
  t,
  labels,
  projectPath,
  onRenameFile,
  onDeleteFile,
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

  // 服务端搜索结果（匹配文件路径的 Set）/ Server-side search results (Set of matched file paths)
  const [searchResults, setSearchResults] = useState<Set<string> | null>(null);
  // 搜索前的展开状态快照，用于清空搜索后恢复 / Snapshot of expanded paths before search, restored on clear
  const prevExpandedPathsRef = useRef<Set<string>>(new Set());
  // 上一次搜索词，用于检测搜索开始/结束 / Previous search query, used to detect search start/end
  const prevSearchQueryRef = useRef<string>("");

  // 加载根目录 / Load root directory
  const loadRoot = useCallback(async () => {
    setRootLoading(true);
    setRootError(null);
    try {
      const data = await api.listDirectory(projectId);
      setRootNodes(data.children);
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to load directory",
      );
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
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [refreshExpandedDirectories]);

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

  // 搜索过滤 / Search filtering — 使用服务端搜索结果
  // Search filtering — uses server-side search results
  // 返回过滤后的根节点与「应渲染路径集合」/ Returns filtered root nodes and the set of paths to render
  // visiblePaths 为 null 表示非搜索模式，渲染层走原路径 / null means non-search mode; render layer uses original path
  const filterNodes = useCallback(
    (nodes: FileNode[]): { nodes: FileNode[]; visiblePaths: Set<string> | null } => {
      if (!searchQuery || !searchResults) {
        return { nodes, visiblePaths: null };
      }

      const visiblePaths = new Set<string>();

      const filter = (items: FileNode[]): FileNode[] => {
        return items
          .map((item) => {
            if (item.isDirectory) {
              const children = childCache.get(item.path) || [];
              const filteredChildren = filter(children);
              // 目录自身名命中，或子节点有命中，则保留 / Keep dir if its own name matches or any descendant matches
              const selfMatch = searchResults.has(item.path);
              if (selfMatch || filteredChildren.length > 0) {
                visiblePaths.add(item.path);
                return { ...item };
              }
              return null;
            }
            if (searchResults.has(item.path)) {
              visiblePaths.add(item.path);
              return item;
            }
            return null;
          })
          .filter((n): n is FileNode => n !== null);
      };

      return { nodes: filter(nodes), visiblePaths };
    },
    [searchQuery, searchResults, childCache],
  );

  // 展开搜索结果中文件的所有祖先目录 / Expand all ancestor directories of search results
  // 同时懒加载缺失缓存的祖先目录 / Also lazily load uncached ancestor directories
  useEffect(() => {
    const prevQuery = prevSearchQueryRef.current;

    // 搜索开始：保存当前展开状态 / Search started: save current expanded state
    if (!prevQuery && searchQuery) {
      prevExpandedPathsRef.current = new Set(expandedPaths);
    }

    // 搜索结束：恢复之前展开状态 / Search ended: restore previous expanded state
    if (prevQuery && !searchQuery) {
      setExpandedPaths(prevExpandedPathsRef.current);
      setSearchResults(null);
      prevSearchQueryRef.current = "";
      return;
    }

    prevSearchQueryRef.current = searchQuery ?? "";

    if (!searchQuery) return;

    // 调用服务端搜索 / Call server-side search
    let cancelled = false;
    api.listDirectory(projectId, undefined, searchQuery).then((data) => {
      if (cancelled) return;
      const resultSet = new Set(data.children.map((n) => n.path));

      // 收集所有需要展开的祖先目录 / Collect all ancestor directories to expand
      const ancestorPaths = new Set<string>();
      for (const p of resultSet) {
        const parts = p.split("/");
        // 文件路径去掉最后一段，目录路径保留 / Strip last segment for files, keep for dirs
        const isFile = !data.children.find((n) => n.path === p)?.isDirectory;
        const segments = isFile ? parts.slice(0, -1) : parts;
        for (let i = 1; i <= segments.length; i++) {
          ancestorPaths.add(segments.slice(0, i).join("/"));
        }
      }

      setSearchResults(resultSet);
      // 懒加载未缓存的祖先目录，避免展开后显示「空目录」/ Lazily load uncached ancestor dirs so expanded dirs show children instead of "empty"
      for (const p of ancestorPaths) {
        if (!childCache.has(p) && !loadingPaths.has(p)) {
          loadChildren(p);
        }
      }
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        for (const p of ancestorPaths) {
          next.add(p);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const { nodes: filteredRootNodes, visiblePaths } = useMemo(
    () => filterNodes(rootNodes),
    [filterNodes, rootNodes],
  );

  return (
    <div className={`file-tree ${className ?? ""}`}>
      {rootLoading ? (
        <div className="file-tree-loading">{labels?.loading ?? t("gitStatusFileTreeLoading")}</div>
      ) : rootError ? (
        <div className="file-tree-error">
          <span>{rootError}</span>
          <button
            type="button"
            className="file-tree-retry-btn"
            onClick={loadRoot}
          >
            {labels?.retry ?? t("gitStatusFileTreeRetry")}
          </button>
        </div>
      ) : filteredRootNodes.length === 0 ? (
        <div className="file-tree-empty">{labels?.empty ?? t("gitStatusFileTreeEmpty")}</div>
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
            selectedPath={selectedPath ?? null}
            onFileClick={onFileClick}
            onToggleExpand={toggleExpand}
            onRetryLoad={loadChildren}
            onContextMenu={setContextMenu}
            visiblePaths={visiblePaths}
            t={t}
          />
        ))
      )}

      {projectPath && (
        <FileContextMenu
          menu={contextMenu}
          projectPath={projectPath}
          onClose={closeContextMenu}
          onRename={onRenameFile}
          onDelete={onDeleteFile}
          t={t}
        />
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
  selectedPath: string | null;
  onFileClick: (filePath: string) => void;
  onToggleExpand: (dirPath: string) => void;
  onRetryLoad: (dirPath: string) => void;
  /** 右键菜单回调 / Context menu callback */
  onContextMenu: (menu: FileContextMenuState) => void;
  /** 搜索时应渲染的路径集合，null 表示非搜索模式 / Paths to render during search; null means non-search mode */
  visiblePaths?: Set<string> | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  labels?: {
    loading?: string;
    retry?: string;
    empty?: string;
    loadingShort?: string;
    emptyDir?: string;
  };
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  expandedPaths,
  childCache,
  loadingPaths,
  errorPaths,
  selectedPath,
  onFileClick,
  onToggleExpand,
  onRetryLoad,
  onContextMenu,
  visiblePaths,
  t,
  labels,
}: FileTreeItemProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isLoading = loadingPaths.has(node.path);
  const error = errorPaths.get(node.path);
  // 搜索模式下只渲染命中集合内的子节点，非搜索模式渲染全部 / In search mode render only matched children; otherwise render all
  const allChildren = childCache.get(node.path) || [];
  const children = visiblePaths
    ? allChildren.filter((c) => visiblePaths.has(c.path))
    : allChildren;
  const isSelected = selectedPath === node.path;

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

  // 右键菜单 + 移动端长按 / Context menu + mobile long-press
  const openContextMenu = useCallback(
    (x: number, y: number) => {
      onContextMenu({
        path: node.path,
        name: node.name,
        isDirectory: node.isDirectory,
        x,
        y,
        showFileOperations: true,
      });
    },
    [node.path, node.name, node.isDirectory, onContextMenu],
  );

  const {
    handleContextMenu,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    wrapClick,
  } = useLongPressContextMenu(openContextMenu);

  const handleClickWrapper = wrapClick(handleClick);

  return (
    <div className="file-tree-item-wrapper">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled by parent */}
      <div
        role="button"
        tabIndex={0}
        className={`file-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClickWrapper}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        title={
          node.isSymlink && node.symlinkTarget
            ? `${node.path} → ${node.symlinkTarget}`
            : node.path
        }
      >
        <div className="file-tree-row">
          {/* 展开/折叠箭头 / Expand/collapse chevron */}
          {node.isDirectory ? (
            <span
              className={`file-tree-chevron ${isExpanded ? "expanded" : ""}`}
            >
              ▶
            </span>
          ) : (
            <span className="file-tree-chevron-placeholder" />
          )}

          {/* 图标 / Icon — 仅文件显示图标，文件夹不显示 / Only files show icons */}
          {!node.isDirectory && (
            <span className="file-tree-icon">
              {getFileIcon(node.name)}
            </span>
          )}

          {/* 文件名 / File name */}
          <span className="file-tree-name">{node.name}</span>

          {/* 元信息 / Meta info */}
          {!node.isDirectory && (
            <span className="file-tree-meta">
              {node.isSymlink ? (
                <span
                  className="file-tree-symlink-icon"
                  title={
                    node.symlinkTarget
                      ? `${node.path} → ${node.symlinkTarget}`
                      : node.path
                  }
                >
                  ↗
                </span>
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
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              <span>{error}</span>
              <button
                type="button"
                className="file-tree-retry-btn"
                onClick={handleRetry}
              >
                {labels?.retry ?? t("gitStatusFileTreeRetry")}
              </button>
            </div>
          ) : isLoading ? (
            <div
              className="file-tree-loading"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              {labels?.loadingShort ?? t("gitStatusFileTreeLoadingShort")}
            </div>
          ) : children.length === 0 ? (
            <div
              className="file-tree-empty"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              {labels?.emptyDir ?? t("gitStatusFileTreeEmptyDir")}
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
                selectedPath={selectedPath}
                onFileClick={onFileClick}
                onToggleExpand={onToggleExpand}
                onRetryLoad={onRetryLoad}
                onContextMenu={onContextMenu}
                visiblePaths={visiblePaths}
                t={t}
                labels={labels}
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
