import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { SessionReader } from "../../src/sessions/reader.js";

const fsControl = vi.hoisted(() => ({
  target: null as string | null,
  readCalls: 0,
  readStarted: null as null | (() => void),
  readGate: null as Promise<void> | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) !== fsControl.target) {
        return actual.readFile(...args);
      }

      fsControl.readCalls += 1;
      const captured = await actual.readFile(...args).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      fsControl.readStarted?.();
      await fsControl.readGate;
      if (!captured.ok) throw captured.error;
      return captured.value;
    },
  };
});

describe("SessionIndexService concurrency", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    fsControl.target = null;
    fsControl.readCalls = 0;
    fsControl.readStarted = null;
    fsControl.readGate = null;
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("shares one cold index state across list and single-summary APIs", async () => {
    const testDir = join(tmpdir(), `session-index-load-${randomUUID()}`);
    tempDirs.push(testDir);
    const projectsDir = join(testDir, "projects");
    const sessionDir = join(projectsDir, "project");
    await mkdir(sessionDir, { recursive: true });
    for (const sessionId of ["session-a", "session-b"]) {
      await writeFile(
        join(sessionDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          message: { content: sessionId },
          uuid: `message-${sessionId}`,
          timestamp: "2026-08-24T12:00:00.000Z",
        })}\n`,
      );
    }

    const service = new SessionIndexService({
      dataDir: join(testDir, "indexes"),
      projectsDir,
      fullValidationIntervalMs: 60_000,
    });
    await service.initialize();
    const reader = new SessionReader({ sessionDir });
    const projectId = toUrlProjectId("/project");
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    fsControl.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fsControl.readStarted = () => signalReadStarted?.();
    fsControl.target = service.getIndexPath(sessionDir);

    const listRequest = service.getSessionsWithCache(
      sessionDir,
      projectId,
      reader,
    );
    const summaryRequest = service.getSessionSummaryWithCache(
      sessionDir,
      projectId,
      "session-a",
      reader,
    );
    await readStarted;

    expect(fsControl.readCalls).toBe(1);
    releaseRead?.();
    expect(await listRequest).toHaveLength(2);
    expect((await summaryRequest)?.id).toBe("session-a");
    expect(
      (await service.getSessionsWithCache(sessionDir, projectId, reader))
        .map((session) => session.id)
        .sort(),
    ).toEqual(["session-a", "session-b"]);
  });
});
