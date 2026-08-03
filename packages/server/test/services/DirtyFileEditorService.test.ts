import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitStatusInfo } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "../../src/sdk/types.js";
import {
  DirtyFileEditorService,
  type DirtyFileEditorProcessContext,
  type DirtyFileSnapshot,
  extractFileMutationPaths,
  isPotentiallyMutatingShell,
} from "../../src/services/DirtyFileEditorService.js";

function toolUse(
  id: string,
  name: string,
  input: unknown,
): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function toolResult(
  id: string,
  timestamp: string,
  isError = false,
): SDKMessage {
  return {
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: isError ? "failed" : "ok",
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

function dirtyStatus(...paths: string[]): GitStatusInfo {
  return {
    isGitRepo: true,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    isClean: paths.length === 0,
    files: paths.map((path) => ({
      path,
      status: "M",
      staged: false,
      linesAdded: 1,
      linesDeleted: 1,
    })),
  };
}

function snapshot(entries: Record<string, string>): DirtyFileSnapshot {
  return { fingerprints: new Map(Object.entries(entries)) };
}

describe("DirtyFileEditorService", () => {
  let dataDir: string;
  let projectPath: string;
  let services: DirtyFileEditorService[];

  function createService(options: {
    captureDirtyFiles?: (projectPath: string) => Promise<DirtyFileSnapshot>;
  } = {}): DirtyFileEditorService {
    const service = new DirtyFileEditorService({ dataDir, ...options });
    services.push(service);
    return service;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-dirty-file-editors-"));
    projectPath = join(dataDir, "project");
    services = [];
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.idle()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it("records every path from a successful structured edit and persists it", async () => {
    const service = createService();
    await service.initialize();
    const process: DirtyFileEditorProcessContext = {
      id: "process-1",
      projectPath,
      sessionId: "session-1",
    };
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/a-renamed.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+added",
      "*** End Patch",
    ].join("\n");

    service.observeMessage(process, toolUse("edit-1", "Edit", { patch }));
    service.observeMessage(
      process,
      toolResult("edit-1", "2026-08-02T10:00:00.000Z"),
    );
    await service.idle();

    const decorated = service.reconcileGitStatus(
      projectPath,
      dirtyStatus("src/a.ts", "src/a-renamed.ts", "src/b.ts"),
    );
    for (const file of decorated.files) {
      expect(file.lastEditor).toEqual({
        sessionId: "session-1",
        observedAt: "2026-08-02T10:00:00.000Z",
      });
    }

    const reloaded = createService();
    await reloaded.initialize();
    expect(
      reloaded.reconcileGitStatus(projectPath, dirtyStatus("src/b.ts"))
        .files[0]?.lastEditor,
    ).toEqual({
      sessionId: "session-1",
      observedAt: "2026-08-02T10:00:00.000Z",
    });
  });

  it("keeps the latest successful editor despite failures and late results", async () => {
    const service = createService();
    await service.initialize();
    const first = {
      id: "process-1",
      projectPath,
      sessionId: "session-first",
    };
    const second = {
      id: "process-2",
      projectPath,
      sessionId: "session-newer",
    };
    const delayed = {
      id: "process-3",
      projectPath,
      sessionId: "session-delayed",
    };

    service.observeMessage(
      first,
      toolUse("write-first", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      first,
      toolResult("write-first", "2026-08-02T10:00:00.000Z"),
    );
    service.observeMessage(
      second,
      toolUse("write-newer", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      second,
      toolResult("write-newer", "2026-08-02T10:00:02.000Z"),
    );
    service.observeMessage(
      second,
      toolUse("write-failed", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      second,
      toolResult("write-failed", "2026-08-02T10:00:03.000Z", true),
    );
    service.observeMessage(
      delayed,
      toolUse("write-delayed", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      delayed,
      toolResult("write-delayed", "2026-08-02T10:00:01.000Z"),
    );

    expect(
      service.reconcileGitStatus(projectPath, dirtyStatus("src/a.ts")).files[0]
        ?.lastEditor,
    ).toEqual({
      sessionId: "session-newer",
      observedAt: "2026-08-02T10:00:02.000Z",
    });
  });

  it("clears attribution when a full Git status says the path is clean", async () => {
    const service = createService();
    await service.initialize();
    const process = {
      id: "process-1",
      projectPath,
      sessionId: "session-1",
    };
    service.observeMessage(
      process,
      toolUse("write", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      process,
      toolResult("write", "2026-08-02T10:00:00.000Z"),
    );

    service.reconcileGitStatus(projectPath, dirtyStatus());
    await service.idle();

    const reloaded = createService();
    await reloaded.initialize();
    expect(
      reloaded.reconcileGitStatus(projectPath, dirtyStatus("src/a.ts"))
        .files[0]?.lastEditor,
    ).toBeUndefined();
  });

  it("retains attribution when Git status is unavailable", async () => {
    const service = createService();
    await service.initialize();
    const process = {
      id: "process-1",
      projectPath,
      sessionId: "session-1",
    };
    service.observeMessage(
      process,
      toolUse("write", "Write", { file_path: "src/a.ts" }),
    );
    service.observeMessage(
      process,
      toolResult("write", "2026-08-02T10:00:00.000Z"),
    );

    service.reconcileGitStatus(
      projectPath,
      {
        ...dirtyStatus(),
        isGitRepo: false,
      },
      { authoritative: false },
    );
    await service.idle();

    const reloaded = createService();
    await reloaded.initialize();
    expect(
      reloaded.reconcileGitStatus(projectPath, dirtyStatus("src/a.ts"))
        .files[0]?.lastEditor,
    ).toEqual({
      sessionId: "session-1",
      observedAt: "2026-08-02T10:00:00.000Z",
    });
  });

  it("retains child attribution behind a compact untracked folder", async () => {
    const service = createService();
    await service.initialize();
    const process = {
      id: "process-1",
      projectPath,
      sessionId: "session-1",
    };
    service.observeMessage(
      process,
      toolUse("write", "Write", { file_path: "generated/a.ts" }),
    );
    service.observeMessage(
      process,
      toolResult("write", "2026-08-02T10:00:00.000Z"),
    );

    const compact = dirtyStatus("generated/");
    compact.files[0]!.status = "?";
    expect(
      service.reconcileGitStatus(projectPath, compact).files[0]?.lastEditor,
    ).toBeUndefined();
    expect(
      service.reconcileGitStatus(projectPath, dirtyStatus("generated/a.ts"))
        .files[0]?.lastEditor?.sessionId,
    ).toBe("session-1");
    expect(
      service.editorsForPaths(projectPath, ["generated/a.ts"]),
    ).toEqual({
      "generated/a.ts": {
        sessionId: "session-1",
        observedAt: "2026-08-02T10:00:00.000Z",
      },
    });
  });

  it("infers recognizable scripted edits from before/after dirty snapshots", async () => {
    const snapshots = [
      snapshot({ "src/a.ts": "old" }),
      snapshot({ "src/a.ts": "new", "src/b.ts": "missing" }),
    ];
    const captureDirtyFiles = vi.fn(async () => snapshots.shift()!);
    const service = createService({ captureDirtyFiles });
    await service.initialize();
    const process = {
      id: "process-1",
      projectPath,
      sessionId: "session-script",
    };

    service.observeMessage(
      process,
      toolUse("bash", "Bash", { command: "sed -i 's/a/b/' src/a.ts" }),
    );
    // A repeated completion-phase tool_use must not replace the real baseline.
    service.observeMessage(
      process,
      toolUse("bash", "Bash", { command: "sed -i 's/a/b/' src/a.ts" }),
    );
    service.observeMessage(
      process,
      toolResult("bash", "2026-08-02T10:00:00.000Z"),
    );
    await service.idle();

    expect(captureDirtyFiles).toHaveBeenCalledTimes(2);
    expect(
      service
        .reconcileGitStatus(
          projectPath,
          dirtyStatus("src/a.ts", "src/b.ts"),
        )
        .files.map((file) => file.lastEditor?.sessionId),
    ).toEqual(["session-script", "session-script"]);
  });
});

describe("dirty-file mutation extraction", () => {
  it("extracts direct, change-list, and multi-file patch paths", () => {
    expect(
      extractFileMutationPaths("Edit", {
        file_path: "src/direct.ts",
        changes: [{ path: "src/change.ts" }],
        rawPatch:
          "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b",
      }),
    ).toEqual([
      "src/direct.ts",
      "src/change.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it("only snapshots shell commands with recognizable write behavior", () => {
    expect(isPotentiallyMutatingShell({ command: "pnpm test" })).toBe(false);
    expect(isPotentiallyMutatingShell({ command: "pnpm format" })).toBe(true);
    expect(
      isPotentiallyMutatingShell({ command: "printf ok > generated.txt" }),
    ).toBe(true);
  });
});
