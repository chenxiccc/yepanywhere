import type {
  GitBlameResult,
  GitCommitDetail,
  GitCommitListResult,
  GitCommitSearchManifest,
  GitCommitSearchRecordsResult,
  GitDiffResult,
  GitFileListResult,
  GitIntegrationOptionsResult,
  GitPullResult,
  GitPushResult,
  GitRemoteCheckResult,
  GitRevisionComparison,
  GitSearchResult,
  GitStatusInfo,
  GitUntrackedFolderInfo,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";

export const gitApi = {
  getGitStatus: (projectId: string) =>
    fetchJSON<GitStatusInfo>(`/projects/${projectId}/git`),

  getGitUntrackedFolder: (projectId: string, path: string) =>
    fetchJSON<GitUntrackedFolderInfo>(
      `/projects/${projectId}/git/untracked-folder?path=${encodeURIComponent(path)}`,
    ),

  checkGitRemote: (projectId: string) =>
    fetchJSON<GitRemoteCheckResult>(`/projects/${projectId}/git/check-remote`, {
      method: "POST",
    }),

  getGitIntegrationOptions: (projectId: string) =>
    fetchJSON<GitIntegrationOptionsResult>(
      `/projects/${projectId}/git/integration-options`,
    ),

  pullGit: (projectId: string) =>
    fetchJSON<GitPullResult>(`/projects/${projectId}/git/pull`, {
      method: "POST",
    }),

  pushGit: (projectId: string) =>
    fetchJSON<GitPushResult>(`/projects/${projectId}/git/push`, {
      method: "POST",
    }),

  getGitDiff: (
    projectId: string,
    params: {
      path: string;
      staged: boolean;
      status: string;
      /** Compare HEAD directly to the filesystem for the synthetic history entry. */
      againstHead?: boolean;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Stage-3 commit browser (topic: source-review-to-session).
  getGitCommits: (
    projectId: string,
    params?: { limit?: number; skip?: number },
  ) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.skip !== undefined) query.set("skip", String(params.skip));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJSON<GitCommitListResult>(
      `/projects/${projectId}/git/commits${suffix}`,
    );
  },

  getGitCommit: (projectId: string, sha: string) =>
    fetchJSON<GitCommitDetail>(
      `/projects/${projectId}/git/commit/${encodeURIComponent(sha)}`,
    ),

  getGitCommitSearchManifest: (projectId: string) =>
    fetchJSON<GitCommitSearchManifest>(
      `/projects/${projectId}/git/commit-search-manifest`,
    ),

  getGitCommitSearchRecords: (projectId: string, shas: string[]) =>
    fetchJSON<GitCommitSearchRecordsResult>(
      `/projects/${projectId}/git/commit-search-records`,
      {
        method: "POST",
        body: JSON.stringify({ shas }),
      },
    ),

  getGitCommitDiff: (
    projectId: string,
    params: {
      sha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/commit-diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getGitComparison: (projectId: string, sha: string) =>
    fetchJSON<GitRevisionComparison>(
      `/projects/${projectId}/git/compare/${encodeURIComponent(sha)}`,
    ),

  getGitComparisonDiff: (
    projectId: string,
    params: {
      baseSha: string;
      headSha: string;
      path: string;
      status: string;
      origPath?: string;
      fullContext?: boolean;
      ignoreWhitespace?: boolean;
    },
  ) =>
    fetchJSON<GitDiffResult>(`/projects/${projectId}/git/compare-diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  getGitBlame: (projectId: string, path: string, rev?: string) => {
    const query = new URLSearchParams({ path });
    if (rev) query.set("rev", rev);
    return fetchJSON<GitBlameResult>(
      `/projects/${projectId}/git/blame?${query.toString()}`,
    );
  },

  listGitFiles: (
    projectId: string,
    params?: { q?: string; limit?: number },
  ) => {
    const query = new URLSearchParams();
    if (params?.q) query.set("q", params.q);
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return fetchJSON<GitFileListResult>(
      `/projects/${projectId}/git/files${suffix}`,
    );
  },

  searchGit: (
    projectId: string,
    params: { q: string; kind: "filename" | "delta"; limit?: number },
  ) => {
    const query = new URLSearchParams({ q: params.q, kind: params.kind });
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    return fetchJSON<GitSearchResult>(
      `/projects/${projectId}/git/search?${query.toString()}`,
    );
  },
};
