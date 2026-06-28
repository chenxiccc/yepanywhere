/**
 * Git Status API methods / Git 状态 API 方法
 *
 * 独立于 client.ts 以避免与上游合并时的冲突。
 * Isolated from client.ts to avoid merge conflicts with upstream.
 */
import type {
  GitBranchInfo,
  GitCreateBranchRequest,
  GitCommitRequest,
  GitHistoryCommitDetail,
  GitHistoryCommitSummary,
  GitMergeBranchRequest,
  GitMergePreviewRequest,
  GitMergePreviewResult,
  GitStashDetail,
  GitStashEntry,
  SourceManagerStatusInfo,
  GitSwitchBranchRequest,
  GitUndoCommitResponse,
} from "@yep-anywhere/shared";

type FetchFn = <T>(path: string, options?: RequestInit) => Promise<T>;

export function createGitStatusApi(fetchJSON: FetchFn) {
  return {
    // 获取源码管理状态（本分支版，含 remote/stashes/latestLocalCommit）
    // Get source-manager status (branch version, with remote/stashes/latestLocalCommit)
    getSourceManagerStatus: (projectId: string) =>
      fetchJSON<SourceManagerStatusInfo>(
        `/source-manager/${projectId}/git`,
      ),

    getGitHistory: (
      projectId: string,
      params?: {
        cursor?: string;
        limit?: number;
        branch?: string;
      },
    ) => {
      const searchParams = new URLSearchParams();
      if (params?.cursor) searchParams.set("cursor", params.cursor);
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.branch) searchParams.set("branch", params.branch);
      const query = searchParams.toString();

      return fetchJSON<{
        commits: GitHistoryCommitSummary[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(`/source-manager/${projectId}/git/history${query ? `?${query}` : ""}`);
    },

    // 轻量端点：仅返回当前 checkout 分支名（供 SessionMenu 取实时分支用）
    // Lightweight endpoint: returns only the current checked-out branch name
    getGitBranchCurrent: (projectId: string) =>
      fetchJSON<{ branch: string | null }>(
        `/source-manager/${projectId}/git/branch`,
      ),

    getGitHistoryCommit: (projectId: string, commit: string) =>
      fetchJSON<{ commit: GitHistoryCommitDetail }>(
        `/source-manager/${projectId}/git/history/${encodeURIComponent(commit)}`,
      ),

    getGitHistoryDiff: (
      projectId: string,
      params: {
        commit: string;
        path: string;
        status: string;
        previousPath?: string;
        fullContext?: boolean;
      },
    ) =>
      fetchJSON<{
        diffHtml: string;
        structuredPatch: Array<{
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
          lines: string[];
        }>;
        markdownHtml?: string;
      }>(`/source-manager/${projectId}/git/history/diff`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    commitGit: (projectId: string, message: string, selectedPaths?: string[]) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(`/source-manager/${projectId}/git/commit`, {
        method: "POST",
        body: JSON.stringify({
          message,
          selectedPaths,
        } satisfies GitCommitRequest),
      }),

    undoGitCommit: (projectId: string) =>
      fetchJSON<GitUndoCommitResponse>(`/source-manager/${projectId}/git/undo`, {
        method: "POST",
      }),

    stashGitChanges: (projectId: string, selectedPaths: string[]) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(`/source-manager/${projectId}/git/stash`, {
        method: "POST",
        body: JSON.stringify({ selectedPaths }),
      }),

    restoreGitStash: (projectId: string, stashRef: string) =>
      fetchJSON<{ status: SourceManagerStatusInfo; stash?: GitStashEntry }>(
        `/source-manager/${projectId}/git/stashes/restore`,
        {
          method: "POST",
          body: JSON.stringify({ stashRef }),
        },
      ),

    getGitStashDetail: (projectId: string, stashRef: string) =>
      fetchJSON<{ stash: GitStashDetail }>(
        `/source-manager/${projectId}/git/stashes/detail`,
        {
          method: "POST",
          body: JSON.stringify({ stashRef }),
        },
      ),

    getGitStashDiff: (
      projectId: string,
      params: {
        stashRef: string;
        path: string;
        status: string;
        previousPath?: string;
        fullContext?: boolean;
      },
    ) =>
      fetchJSON<{
        diffHtml: string;
        structuredPatch: Array<{
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
          lines: string[];
        }>;
        markdownHtml?: string;
      }>(`/source-manager/${projectId}/git/stashes/diff`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    discardGitStash: (projectId: string, stashRef: string) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(
        `/source-manager/${projectId}/git/stashes/discard`,
        {
          method: "POST",
          body: JSON.stringify({ stashRef }),
        },
      ),

    discardGitChanges: (projectId: string, selectedPaths: string[]) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(`/source-manager/${projectId}/git/discard`, {
        method: "POST",
        body: JSON.stringify({ selectedPaths }),
      }),

    pushGit: (projectId: string) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(`/source-manager/${projectId}/git/push`, {
        method: "POST",
      }),

    fetchGit: (projectId: string) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(`/source-manager/${projectId}/git/fetch`, {
        method: "POST",
      }),

    getGitBranches: (projectId: string) =>
      fetchJSON<{ branches: GitBranchInfo[] }>(
        `/source-manager/${projectId}/git/branches`,
      ),

    createGitBranch: (projectId: string, body: GitCreateBranchRequest) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(
        `/source-manager/${projectId}/git/create-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    switchGitBranch: (projectId: string, body: GitSwitchBranchRequest) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(
        `/source-manager/${projectId}/git/switch-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    mergeGitBranch: (projectId: string, body: GitMergeBranchRequest) =>
      fetchJSON<{ status: SourceManagerStatusInfo }>(
        `/source-manager/${projectId}/git/merge-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    previewGitMerge: (projectId: string, body: GitMergePreviewRequest) =>
      fetchJSON<{ result: GitMergePreviewResult }>(
        `/source-manager/${projectId}/git/merge-preview`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

  };
}
