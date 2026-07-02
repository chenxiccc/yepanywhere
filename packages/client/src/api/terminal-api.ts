/**
 * Terminal API methods / 终端 API 方法
 *
 * 独立于 client.ts 以避免与上游合并时的冲突。
 * Isolated from client.ts to avoid merge conflicts with upstream.
 */

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
}

type FetchFn = <T>(path: string, options?: RequestInit) => Promise<T>;

/**
 * Desktop auth token query string for WebSocket connections.
 * 桌面认证 token 查询字符串，用于 WebSocket 连接。
 * Reused by both the main WebSocket connection and terminal WebSocket.
 */
export function getDesktopTokenQuery(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const token = params.get("desktop_token");
  return token ? `desktop_token=${encodeURIComponent(token)}` : "";
}

export function createTerminalApi(fetchJSON: FetchFn) {
  return {
    getProjectTerminalTabs: (projectId: string) =>
      fetchJSON<{ tabs: TerminalTab[] }>(
        `/projects/${projectId}/terminal-tabs`,
      ),

    createProjectTerminalTab: (
      projectId: string,
      payload?: { title?: string; cwd?: string },
    ) =>
      fetchJSON<{ tab: TerminalTab }>(
        `/projects/${projectId}/terminal-tabs`,
        {
          method: "POST",
          body: JSON.stringify(payload ?? {}),
        },
      ),

    renameProjectTerminalTab: (
      projectId: string,
      tabId: string,
      title: string,
    ) =>
      fetchJSON<{ tab: TerminalTab }>(
        `/projects/${projectId}/terminal-tabs/${tabId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title }),
        },
      ),

    deleteProjectTerminalTab: (projectId: string, tabId: string) =>
      fetchJSON<{ ok: boolean }>(
        `/projects/${projectId}/terminal-tabs/${tabId}`,
        {
          method: "DELETE",
        },
      ),
  };
}