/**
 * File listing API methods / 文件列表 API 方法
 *
 * 独立于 git-status.ts 以解耦文件浏览器功能。
 * Isolated from git-status.ts to decouple the file browser feature.
 */
import type { FileListResponse } from "@yep-anywhere/shared";

type FetchFn = <T>(path: string, options?: RequestInit) => Promise<T>;

export function createFileTreeApi(fetchJSON: FetchFn) {
  return {
    /** 浅层目录列表，可递归搜索 / Shallow directory listing, with optional recursive search */
    listDirectory: (projectId: string, path?: string, search?: string) => {
      const params = new URLSearchParams();
      params.set("path", path ?? "");
      if (search) params.set("search", search);
      return fetchJSON<FileListResponse>(
        `/projects/${projectId}/files/list?${params.toString()}`,
      );
    },

    /** 删除文件或文件夹 / Delete a file or directory */
    deleteFile: (projectId: string, path: string) => {
      return fetchJSON<{ success: boolean }>(
        `/projects/${projectId}/files`,
        {
          method: "DELETE",
          body: JSON.stringify({ path }),
        },
      );
    },

    /** 重命名文件或文件夹 / Rename a file or directory */
    renameFile: (projectId: string, path: string, newName: string) => {
      return fetchJSON<{ success: boolean }>(
        `/projects/${projectId}/files/rename`,
        {
          method: "POST",
          body: JSON.stringify({ path, newName }),
        },
      );
    },
  };
}