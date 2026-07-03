import { describe, expect, it, vi } from "vitest";
import { TerminalWorkspaceRegistry } from "../../src/terminal/TerminalWorkspaceRegistry.js";
import type {
  PtyFactory,
  PtyHandle,
} from "../../src/terminal/TerminalWorkspaceTypes.js";

class FakePty implements PtyHandle {
  public readonly writes: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public killed = false;
  // 背压计数 / backpressure counters
  public paused = 0;
  public resumed = 0;
  private onDataHandlers: Array<(data: string) => void> = [];
  private onExitHandlers: Array<(event: { exitCode: number | null }) => void> =
    [];

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  pause(): void {
    this.paused++;
  }

  resume(): void {
    this.resumed++;
  }

  onData(listener: (data: string) => void): void {
    this.onDataHandlers.push(listener);
  }

  onExit(listener: (event: { exitCode: number | null }) => void): void {
    this.onExitHandlers.push(listener);
  }

  emitData(data: string): void {
    for (const handler of this.onDataHandlers) {
      handler(data);
    }
  }

  emitExit(exitCode: number | null): void {
    for (const handler of this.onExitHandlers) {
      handler({ exitCode });
    }
  }
}

function createFactory(instances: FakePty[]): PtyFactory {
  return vi.fn((_projectPath: string, _cols: number, _rows: number) => {
    const pty = new FakePty();
    instances.push(pty);
    return pty;
  });
}

describe("TerminalWorkspaceRegistry", () => {
  it("creates, lists, renames, and deletes project terminal tabs", () => {
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });

    const tab = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });

    expect(registry.listTabs("proj-1")).toHaveLength(1);
    expect(tab.title).toBe("Terminal 1");

    const renamed = registry.renameTab("proj-1", tab.id, "Build");
    expect(renamed.title).toBe("Build");

    registry.deleteTab("proj-1", tab.id);

    expect(registry.listTabs("proj-1")).toHaveLength(0);
    expect(instances[0]?.killed).toBe(true);
  });

  it("reuses terminal numbers based on currently open tabs", () => {
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });

    const first = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });
    registry.deleteTab("proj-1", first.id);

    const second = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });

    expect(first.title).toBe("Terminal 1");
    expect(second.title).toBe("Terminal 1");
  });

  it("keeps PTY state alive after disconnect and replays buffered output on reconnect", () => {
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });
    const tab = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });
    const firstClient = {
      messages: [] as unknown[],
      rawChunks: [] as string[],
      sendMessage(message: unknown) {
        this.messages.push(message);
      },
      sendRaw(data: string, onFlush?: () => void) {
        this.rawChunks.push(data);
        onFlush?.();
      },
    };

    const firstAttachment = registry.attachClient(
      "proj-1",
      tab.id,
      firstClient,
    );
    expect(firstAttachment.snapshot).toBe("");

    instances[0]?.emitData("hello");
    registry.detachClient("proj-1", tab.id, firstClient);

    expect(instances[0]?.killed).toBe(false);

    const secondClient = {
      messages: [] as unknown[],
      rawChunks: [] as string[],
      sendMessage(message: unknown) {
        this.messages.push(message);
      },
      sendRaw(data: string, onFlush?: () => void) {
        this.rawChunks.push(data);
        onFlush?.();
      },
    };

    const secondAttachment = registry.attachClient(
      "proj-1",
      tab.id,
      secondClient,
    );

    expect(secondAttachment.snapshot).toContain("hello");
    expect(secondAttachment.tab.status).toBe("running");
  });

  it("isolates tabs by projectId", () => {
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });

    registry.createTab({ projectId: "proj-1", projectPath: "/tmp/project-1" });
    registry.createTab({ projectId: "proj-2", projectPath: "/tmp/project-2" });

    expect(registry.listTabs("proj-1")).toHaveLength(1);
    expect(registry.listTabs("proj-2")).toHaveLength(1);
  });

  it("throws for missing tab", () => {
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory([]),
      maxBufferBytes: 1024,
    });

    expect(() =>
      registry.attachClient("proj-1", "missing", {
        sendMessage() {},
        sendRaw() {},
      }),
    ).toThrow(/Terminal tab not found/);
  });

  it("pauses PTY on output and resumes after single client flushes", () => {
    // 单 client：emitData 后 pause，onFlush 触发后 resume / single client
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });
    const tab = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });
    const flushes: Array<() => void> = [];
    const client = {
      messages: [] as unknown[],
      rawChunks: [] as string[],
      sendMessage(message: unknown) {
        this.messages.push(message);
      },
      sendRaw(data: string, onFlush?: () => void) {
        this.rawChunks.push(data);
        if (onFlush) flushes.push(onFlush);
      },
    };
    registry.attachClient("proj-1", tab.id, client);

    instances[0]?.emitData("chunk");

    expect(instances[0]?.paused).toBe(1);
    expect(instances[0]?.resumed).toBe(0);
    expect(client.rawChunks).toContain("chunk");

    // 触发 flush → resume / fire flush → resume
    flushes[0]?.();
    expect(instances[0]?.resumed).toBe(1);
  });

  it("resumes immediately when no clients are attached", () => {
    // 无 client：emitData 后立即 resume，不等待 / no clients
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });
    registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });

    instances[0]?.emitData("chunk");

    expect(instances[0]?.paused).toBe(1);
    expect(instances[0]?.resumed).toBe(1);
  });

  it("resumes only after all clients flush in multi-client mode", () => {
    // 多 client：两个都 flush 才 resume / multi-client: resume after both flush
    const instances: FakePty[] = [];
    const registry = new TerminalWorkspaceRegistry({
      createPty: createFactory(instances),
      maxBufferBytes: 1024,
    });
    const tab = registry.createTab({
      projectId: "proj-1",
      projectPath: "/tmp/project-1",
    });
    const flushes: Array<() => void> = [];
    const makeClient = () => ({
      messages: [] as unknown[],
      rawChunks: [] as string[],
      sendMessage(message: unknown) {
        this.messages.push(message);
      },
      sendRaw(data: string, onFlush?: () => void) {
        this.rawChunks.push(data);
        if (onFlush) flushes.push(onFlush);
      },
    });
    const a = makeClient();
    const b = makeClient();
    registry.attachClient("proj-1", tab.id, a);
    registry.attachClient("proj-1", tab.id, b);

    instances[0]?.emitData("chunk");

    expect(instances[0]?.paused).toBe(1);
    expect(instances[0]?.resumed).toBe(0);

    // 只触发第一个 flush → 仍不 resume / first flush only → not yet
    flushes[0]?.();
    expect(instances[0]?.resumed).toBe(0);

    // 触发第二个 → resume / second flush → resume
    flushes[1]?.();
    expect(instances[0]?.resumed).toBe(1);
  });
});
