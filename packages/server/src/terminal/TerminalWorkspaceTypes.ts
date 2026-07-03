export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | null }) => void): void;
}

export type PtyFactory = (
  projectPath: string,
  cols: number,
  rows: number,
) => PtyHandle;

export interface TerminalTabSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export interface TerminalServerMessage {
  type: "snapshot" | "output" | "exit" | "error" | "pong";
  data?: string;
  exitCode?: number | null;
  message?: string;
}

/**
 * 客户端数据接收通道 / Client sink for receiving terminal data.
 *
 * - sendMessage: 发送 JSON 控制消息（snapshot/exit/error/pong）/ sends JSON control messages
 * - sendRaw: 发送原始 PTY 输出字节，onFlush 在数据 flush 到网络后回调（背压用）
 *            / sends raw PTY output bytes; onFlush fires after data is flushed to network (for backpressure)
 */
export interface TerminalClientSink {
  sendMessage(message: TerminalServerMessage): void;
  sendRaw(data: string, onFlush?: () => void): void;
}
