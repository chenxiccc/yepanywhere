/**
 * Terminal types — 终端类型
 *
 * 独立于其他 shared 文件以避免与上游合并时的冲突。
 * Isolated from other shared files to avoid merge conflicts with upstream.
 */

/** 终端 tab 摘要（客户端使用） / Terminal tab summary (client-side) */
export interface TerminalTabSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
}

/** 服务端 → 客户端 WebSocket 消息 / Server → Client WebSocket messages */
export type TerminalServerMessage =
  | { type: "snapshot"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; message: string };

/** 客户端 → 服务端 WebSocket 消息 / Client → Server WebSocket messages */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };