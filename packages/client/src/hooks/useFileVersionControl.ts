import {
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  type GitCommitDetail,
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
import { useRetainedClientQuery } from "./useRetainedClientQuery";
import { useRetainedVersionInfo } from "./useVersion";

const HEAD_COMMIT_STALE_MS = 30_000;
const HEAD_COMMIT_TTL_MS = 60_000;

function headCommitRetentionKey(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
): RouteRetentionKeyInput {
  return {
    sourceKey,
    routeId: "git-status:file-link-head",
    projectId,
  };
}

function useHeadCommit(
  projectId: string | undefined,
  headHash: string | undefined,
): GitCommitDetail | null {
  const sourceKey = useClientSummarySourceKey();
  const retentionKey = useMemo(
    () => (projectId ? headCommitRetentionKey(sourceKey, projectId) : null),
    [projectId, sourceKey],
  );
  const retained = useSyncExternalStore(
    subscribeRouteRetention,
    () =>
      retentionKey
        ? readRouteRetention<GitCommitDetail>(retentionKey, {
            touch: false,
            recordDiagnostics: false,
          })
        : null,
    () => null,
  );
  const current = retained?.hash === headHash ? retained : null;

  useRetainedClientQuery({
    sourceKey,
    key: {
      endpoint: "git-status:file-link-head",
      projectId: projectId ?? null,
      headHash: headHash ?? null,
    },
    enabled: Boolean(projectId && headHash),
    hasData: current !== null,
    staleTimeMs: HEAD_COMMIT_STALE_MS,
    meta: { projectId, headHash },
    fetcher: async (context) => {
      const meta = context.meta as {
        projectId?: string;
        headHash?: string;
      };
      if (!meta.projectId || !meta.headHash) {
        throw new Error("Project and HEAD commit are required");
      }
      return api.getGitCommit(meta.projectId, meta.headHash);
    },
    applySnapshot: (result, context) => {
      const meta = context.meta as { projectId?: string };
      if (!meta.projectId) return;
      writeRouteRetention(
        headCommitRetentionKey(context.sourceKey, meta.projectId),
        result,
        { ttlMs: HEAD_COMMIT_TTL_MS },
      );
    },
  });

  return current;
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

function changeIncludesPath(
  path: string,
  change: { path: string; origPath?: string },
): boolean {
  return (
    change.path === path ||
    change.origPath === path ||
    (change.path.endsWith("/") && path.startsWith(change.path))
  );
}

export function useFileVersionControl(
  projectId: string | undefined,
  filePath: string,
): {
  dirty: boolean;
  headCommitHash?: string;
  relativePath: string | null;
} {
  const sourceKey = useClientSummarySourceKey();
  const version = useRetainedVersionInfo(sourceKey);
  const supportsStatus = serverHasCapability(
    version,
    GIT_STATUS_ENHANCED_CAPABILITY,
  );
  const supportsHistory = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_CAPABILITY,
  );
  const enabledProjectId = supportsStatus ? projectId : undefined;
  const { gitStatus } = useGitStatus(enabledProjectId, { poll: false });
  const relativePath = useMemo(
    () => projectRelativeGitPath(filePath),
    [filePath],
  );
  const headHash =
    supportsHistory && gitStatus?.isGitRepo
      ? gitStatus.recentCommits?.[0]?.hash
      : undefined;
  const headCommit = useHeadCommit(enabledProjectId, headHash);
  const dirty = Boolean(
    relativePath &&
      gitStatus?.files.some((change) =>
        changeIncludesPath(relativePath, change),
      ),
  );
  const headIncludesFile = Boolean(
    relativePath &&
      headCommit?.files.some((change) =>
        changeIncludesPath(relativePath, change),
      ),
  );

  return {
    dirty,
    relativePath,
    ...(headIncludesFile && headHash ? { headCommitHash: headHash } : {}),
  };
}
