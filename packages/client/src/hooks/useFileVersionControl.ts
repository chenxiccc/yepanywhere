import {
  GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  type GitFileChange,
  type GitWorkingTreeChange,
  type GitWorkingTreeFile,
  type GitFileProjectionManifest,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useMemo, useSyncExternalStore } from "react";
import { api } from "../api/client";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import {
  readRouteRetention,
  subscribeRouteRetention,
  type RouteRetentionKeyInput,
  writeRouteRetention,
} from "../lib/routeRetention";
import { normalizePathSeparators } from "../lib/text";
import { useGitStatus } from "./useGitStatus";
import { useProjectWorktree } from "./useProjectWorktree";
import { useRetainedClientQuery } from "./useRetainedClientQuery";
import { useRetainedVersionInfo } from "./useVersion";

const FILE_PROJECTIONS_STALE_MS = 5_000;
const FILE_PROJECTIONS_TTL_MS = 60_000;

interface RetainedFileProjectionManifest {
  statusKey: string;
  value: GitFileProjectionManifest;
}

function manifestRetentionKey(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
): RouteRetentionKeyInput {
  return {
    sourceKey,
    routeId: "git-status:file-projections",
    projectId,
  };
}

function useFileProjectionManifest(
  sourceKey: ClientSummarySourceKey,
  projectId: string | undefined,
  statusKey: string | null,
): {
  manifest: GitFileProjectionManifest | null;
  loading: boolean;
} {
  const retentionKey = useMemo(
    () => (projectId ? manifestRetentionKey(sourceKey, projectId) : null),
    [projectId, sourceKey],
  );
  const retained = useSyncExternalStore(
    subscribeRouteRetention,
    () =>
      retentionKey
        ? readRouteRetention<RetainedFileProjectionManifest>(retentionKey, {
            touch: false,
            recordDiagnostics: false,
          })
        : null,
    () => null,
  );
  const current = retained?.statusKey === statusKey ? retained.value : null;

  const query = useRetainedClientQuery({
    sourceKey,
    key: {
      endpoint: "git-status:file-projections",
      projectId: projectId ?? null,
      statusKey,
    },
    enabled: Boolean(projectId && statusKey),
    hasData: current !== null,
    staleTimeMs: FILE_PROJECTIONS_STALE_MS,
    meta: { projectId, statusKey },
    fetcher: async (context) => {
      const meta = context.meta as {
        projectId?: string;
      };
      if (!meta.projectId) {
        throw new Error("Project is required for file projections");
      }
      return api.getGitFileProjections(meta.projectId);
    },
    applySnapshot: (result, context) => {
      const meta = context.meta as {
        projectId?: string;
        statusKey?: string | null;
      };
      if (!meta.projectId || !meta.statusKey) return;
      writeRouteRetention(
        manifestRetentionKey(context.sourceKey, meta.projectId),
        { statusKey: meta.statusKey, value: result },
        { ttlMs: FILE_PROJECTIONS_TTL_MS },
      );
    },
  });

  return {
    manifest: current,
    loading: Boolean(statusKey && !current && !query.error),
  };
}

function projectRelativeGitPath(filePath: string): string | null {
  const normalized = normalizePathSeparators(filePath).replace(/^\.\/+/, "");
  const isAbsolute =
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-zA-Z]:\//.test(normalized);
  const leavesProject = normalized === ".." || normalized.startsWith("../");
  return normalized && !isAbsolute && !leavesProject ? normalized : null;
}

function findFile(
  path: string | null,
  files: readonly GitFileChange[],
): GitFileChange | null {
  if (!path) return null;
  return (
    files.find((file) => file.path === path || file.origPath === path) ?? null
  );
}

function embeddedFileChange(
  row: GitWorkingTreeFile | undefined,
  path: string | null,
  change: GitWorkingTreeChange | undefined,
): GitFileChange | null {
  if (!row || !path || !change) return null;
  if (row.path !== path && change.origPath !== path) return null;
  return { path: row.path, ...change };
}

function findLiveRow(
  path: string | null,
  files: readonly GitWorkingTreeFile[],
): GitWorkingTreeFile | undefined {
  if (!path) return undefined;
  return files.find(
    (file) =>
      file.path === path ||
      file.worktreeChanges?.some((change) => change.origPath === path) ||
      file.cumulativeChange?.origPath === path,
  );
}

function gitStatusKey(status: {
  recentCommits?: readonly { hash: string }[];
  files: readonly GitFileChange[];
}): string {
  return JSON.stringify([
    status.recentCommits?.[0]?.hash ?? null,
    status.files.map((file) => [
      file.path,
      file.origPath ?? null,
      file.status,
      file.staged,
      file.linesAdded,
      file.linesDeleted,
    ]),
  ]);
}

export function useFileVersionControl(
  projectId: string | undefined,
  filePath: string,
): {
  cumulativeFile: GitFileChange | null;
  loading: boolean;
  relativePath: string | null;
  supported: boolean;
  worktreeFile: GitFileChange | null;
} {
  const sourceKey = useClientSummarySourceKey();
  const version = useRetainedVersionInfo(sourceKey);
  const supportsStatus = serverHasCapability(
    version,
    GIT_STATUS_ENHANCED_CAPABILITY,
  );
  const supported = serverHasCapability(
    version,
    GIT_FILE_DIFF_PROJECTIONS_CAPABILITY,
  );
  const supportsLiveWorktree =
    serverHasCapability(version, GIT_LIVE_WORKTREE_SETTING_CAPABILITY) &&
    serverHasCapability(version, GIT_WORKING_TREE_SECTIONS_CAPABILITY);
  const relativePath = useMemo(
    () => projectRelativeGitPath(filePath),
    [filePath],
  );
  const enabledStatusProjectId =
    supportsStatus && supported && relativePath ? projectId : undefined;
  const {
    gitStatus,
    loading: statusLoading,
    error: statusError,
  } = useGitStatus(enabledStatusProjectId, {
    poll: false,
    omitUntracked: supportsLiveWorktree,
  });
  const liveWorktree = useProjectWorktree(
    projectId ?? "",
    { tracked: true, untracked: true, ignored: false },
    Boolean(
      projectId &&
        relativePath &&
        supported &&
        supportsLiveWorktree &&
        gitStatus?.isGitRepo,
    ),
  );
  const enabledLegacyProjectId =
    enabledStatusProjectId && !supportsLiveWorktree
      ? enabledStatusProjectId
      : undefined;
  const statusKey =
    gitStatus?.isGitRepo && relativePath ? gitStatusKey(gitStatus) : null;
  const projection = useFileProjectionManifest(
    sourceKey,
    enabledLegacyProjectId,
    statusKey,
  );
  const liveRow = findLiveRow(relativePath, liveWorktree.files);
  const liveWorktreeChange = liveRow?.worktreeChanges?.at(-1);

  return {
    cumulativeFile: supportsLiveWorktree
      ? embeddedFileChange(liveRow, relativePath, liveRow?.cumulativeChange)
      : findFile(relativePath, projection.manifest?.cumulativeFiles ?? []),
    loading: Boolean(
      projectId &&
        relativePath &&
        (version === null ||
          (supported &&
            enabledStatusProjectId &&
            (statusLoading ||
              (!gitStatus && !statusError) ||
              (gitStatus?.isGitRepo &&
                (supportsLiveWorktree
                  ? liveWorktree.loading
                  : projection.loading))))),
    ),
    relativePath,
    supported,
    worktreeFile: supportsLiveWorktree
      ? embeddedFileChange(liveRow, relativePath, liveWorktreeChange)
      : findFile(relativePath, projection.manifest?.worktreeFiles ?? []),
  };
}
