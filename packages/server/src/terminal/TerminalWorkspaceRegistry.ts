import { randomUUID } from "node:crypto";
import type {
  PtyFactory,
  PtyHandle,
  TerminalClientSink,
  TerminalServerMessage,
  TerminalTabSummary,
} from "./TerminalWorkspaceTypes.js";

interface TerminalTabRecord {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  pty: PtyHandle;
  outputBuffer: string;
  attachedClients: Set<TerminalClientSink>;
}

interface TerminalWorkspace {
  tabs: Map<string, TerminalTabRecord>;
}

export interface CreateTerminalTabInput {
  projectId: string;
  projectPath: string;
  title?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalWorkspaceRegistryOptions {
  createPty: PtyFactory;
  maxBufferBytes?: number;
  now?: () => Date;
}

export class TerminalWorkspaceRegistry {
  private readonly workspaces = new Map<string, TerminalWorkspace>();
  private readonly createPty: PtyFactory;
  private readonly maxBufferBytes: number;
  private readonly now: () => Date;

  constructor(options: TerminalWorkspaceRegistryOptions) {
    this.createPty = options.createPty;
    this.maxBufferBytes = options.maxBufferBytes ?? 262144;
    this.now = options.now ?? (() => new Date());
  }

  listTabs(projectId: string): TerminalTabSummary[] {
    const workspace = this.workspaces.get(projectId);
    if (!workspace) {
      return [];
    }

    return Array.from(workspace.tabs.values()).map((tab) =>
      this.toSummary(tab),
    );
  }

  createTab(input: CreateTerminalTabInput): TerminalTabSummary {
    const workspace = this.getOrCreateWorkspace(input.projectId);
    const now = this.now().toISOString();
    const index = workspace.tabs.size + 1;
    const pty = this.createPty(
      input.cwd ?? input.projectPath,
      input.cols ?? 80,
      input.rows ?? 24,
    );
    const record: TerminalTabRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title?.trim() || `Terminal ${index}`,
      cwd: input.cwd ?? input.projectPath,
      createdAt: now,
      updatedAt: now,
      status: "running",
      exitCode: null,
      pty,
      outputBuffer: "",
      attachedClients: new Set(),
    };

    pty.onData((data) => {
      record.outputBuffer = this.appendToBuffer(record.outputBuffer, data);
      record.updatedAt = this.now().toISOString();
      this.broadcastRaw(record, data);
    });

    pty.onExit(({ exitCode }) => {
      record.status = "exited";
      record.exitCode = exitCode;
      record.updatedAt = this.now().toISOString();
      this.broadcastMessage(record, { type: "exit", exitCode });
    });

    workspace.tabs.set(record.id, record);
    return this.toSummary(record);
  }

  renameTab(
    projectId: string,
    tabId: string,
    title: string,
  ): TerminalTabSummary {
    const record = this.getTabRecord(projectId, tabId);
    record.title = title.trim() || record.title;
    record.updatedAt = this.now().toISOString();
    return this.toSummary(record);
  }

  deleteTab(projectId: string, tabId: string): void {
    const workspace = this.workspaces.get(projectId);
    const record = workspace?.tabs.get(tabId);
    if (!workspace || !record) {
      throw new Error("Terminal tab not found");
    }

    record.pty.kill();
    workspace.tabs.delete(tabId);
  }

  attachClient(
    projectId: string,
    tabId: string,
    client: TerminalClientSink,
  ): {
    tab: TerminalTabSummary;
    snapshot: string;
  } {
    const record = this.getTabRecord(projectId, tabId);
    record.attachedClients.add(client);
    return {
      tab: this.toSummary(record),
      snapshot: record.outputBuffer,
    };
  }

  detachClient(
    projectId: string,
    tabId: string,
    client: TerminalClientSink,
  ): void {
    const record = this.getTabRecord(projectId, tabId);
    record.attachedClients.delete(client);
  }

  writeInput(projectId: string, tabId: string, data: string): void {
    const record = this.getTabRecord(projectId, tabId);
    record.pty.write(data);
    record.updatedAt = this.now().toISOString();
  }

  resizeTab(
    projectId: string,
    tabId: string,
    cols: number,
    rows: number,
  ): void {
    const record = this.getTabRecord(projectId, tabId);
    record.pty.resize(cols, rows);
    record.updatedAt = this.now().toISOString();
  }

  dispose(): void {
    for (const workspace of this.workspaces.values()) {
      for (const tab of workspace.tabs.values()) {
        tab.pty.kill();
      }
    }
    this.workspaces.clear();
  }

  private getOrCreateWorkspace(projectId: string): TerminalWorkspace {
    let workspace = this.workspaces.get(projectId);
    if (!workspace) {
      workspace = { tabs: new Map() };
      this.workspaces.set(projectId, workspace);
    }
    return workspace;
  }

  private getTabRecord(projectId: string, tabId: string): TerminalTabRecord {
    const record = this.workspaces.get(projectId)?.tabs.get(tabId);
    if (!record) {
      throw new Error("Terminal tab not found");
    }
    return record;
  }

  private toSummary(tab: TerminalTabRecord): TerminalTabSummary {
    return {
      id: tab.id,
      title: tab.title,
      cwd: tab.cwd,
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      status: tab.status,
      exitCode: tab.exitCode,
    };
  }

  /**
   * 广播 JSON 控制消息给所有 attached client / Broadcast JSON control message to all attached clients.
   */
  private broadcastMessage(
    record: TerminalTabRecord,
    message: TerminalServerMessage,
  ): void {
    for (const client of record.attachedClients) {
      client.sendMessage(message);
    }
  }

  /**
   * 广播原始 PTY 输出字节给所有 attached client / Broadcast raw PTY output bytes to all attached clients.
   * onFlush 在数据 flush 到网络后回调（背压用，C2 接入）/ onFlush fires after flush (backpressure, wired in C2).
   */
  private broadcastRaw(
    record: TerminalTabRecord,
    data: string,
    onFlush?: () => void,
  ): void {
    for (const client of record.attachedClients) {
      client.sendRaw(data, onFlush);
    }
  }

  private appendToBuffer(current: string, chunk: string): string {
    const next = current + chunk;
    if (next.length <= this.maxBufferBytes) {
      return next;
    }
    return next.slice(next.length - this.maxBufferBytes);
  }
}
