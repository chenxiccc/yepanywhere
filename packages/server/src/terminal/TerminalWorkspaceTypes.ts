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
  type: "snapshot" | "output" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
  message?: string;
}

export interface TerminalClientSink {
  send(message: TerminalServerMessage): void;
}
