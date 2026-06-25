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
  GitStatusInfo,
  GitSwitchBranchRequest,
  GitUndoCommitResponse,
} from "@yep-anywhere/shared";

type FetchFn = <T>(path: string, options?: RequestInit) => Promise<T>;

export function createGitStatusApi(fetchJSON: FetchFn) {
  return {
    getGitHistory: (
      projectId: string,
      params?: {
        cursor?: string;
        limit?: number;
      },
    ) => {
      const searchParams = new URLSearchParams();
      if (params?.cursor) searchParams.set("cursor", params.cursor);
      if (params?.limit) searchParams.set("limit", String(params.limit));
      const query = searchParams.toString();

      return fetchJSON<{
        commits: GitHistoryCommitSummary[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(`/projects/${projectId}/git/history${query ? `?${query}` : ""}`);
    },

    getGitHistoryCommit: (projectId: string, commit: string) =>
      fetchJSON<{ commit: GitHistoryCommitDetail }>(
        `/projects/${projectId}/git/history/${encodeURIComponent(commit)}`,
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
      }>(`/projects/${projectId}/git/history/diff`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    commitGit: (projectId: string, message: string, selectedPaths?: string[]) =>
      fetchJSON<{ status: GitStatusInfo }>(`/projects/${projectId}/git/commit`, {
        method: "POST",
        body: JSON.stringify({
          message,
          selectedPaths,
        } satisfies GitCommitRequest),
      }),

    undoGitCommit: (projectId: string) =>
      fetchJSON<GitUndoCommitResponse>(`/projects/${projectId}/git/undo`, {
        method: "POST",
      }),

    stashGitChanges: (projectId: string, selectedPaths: string[]) =>
      fetchJSON<{ status: GitStatusInfo }>(`/projects/${projectId}/git/stash`, {
        method: "POST",
        body: JSON.stringify({ selectedPaths }),
      }),

    restoreGitStash: (projectId: string, stashRef: string) =>
      fetchJSON<{ status: GitStatusInfo; stash?: GitStashEntry }>(
        `/projects/${projectId}/git/stashes/restore`,
        {
          method: "POST",
          body: JSON.stringify({ stashRef }),
        },
      ),

    getGitStashDetail: (projectId: string, stashRef: string) =>
      fetchJSON<{ stash: GitStashDetail }>(
        `/projects/${projectId}/git/stashes/detail`,
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
      }>(`/projects/${projectId}/git/stashes/diff`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    discardGitStash: (projectId: string, stashRef: string) =>
      fetchJSON<{ status: GitStatusInfo }>(
        `/projects/${projectId}/git/stashes/discard`,
        {
          method: "POST",
          body: JSON.stringify({ stashRef }),
        },
      ),

    discardGitChanges: (projectId: string, selectedPaths: string[]) =>
      fetchJSON<{ status: GitStatusInfo }>(`/projects/${projectId}/git/discard`, {
        method: "POST",
        body: JSON.stringify({ selectedPaths }),
      }),

    pushGit: (projectId: string) =>
      fetchJSON<{ status: GitStatusInfo }>(`/projects/${projectId}/git/push`, {
        method: "POST",
      }),

    fetchGit: (projectId: string) =>
      fetchJSON<{ status: GitStatusInfo }>(`/projects/${projectId}/git/fetch`, {
        method: "POST",
      }),

    getGitBranches: (projectId: string) =>
      fetchJSON<{ branches: GitBranchInfo[] }>(
        `/projects/${projectId}/git/branches`,
      ),

    createGitBranch: (projectId: string, body: GitCreateBranchRequest) =>
      fetchJSON<{ status: GitStatusInfo }>(
        `/projects/${projectId}/git/create-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    switchGitBranch: (projectId: string, body: GitSwitchBranchRequest) =>
      fetchJSON<{ status: GitStatusInfo }>(
        `/projects/${projectId}/git/switch-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    mergeGitBranch: (projectId: string, body: GitMergeBranchRequest) =>
      fetchJSON<{ status: GitStatusInfo }>(
        `/projects/${projectId}/git/merge-branch`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),

    previewGitMerge: (projectId: string, body: GitMergePreviewRequest) =>
      fetchJSON<{ result: GitMergePreviewResult }>(
        `/projects/${projectId}/git/merge-preview`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
  };
}
