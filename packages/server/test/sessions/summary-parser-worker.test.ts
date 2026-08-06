import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SummaryParserClient,
  resolveSummaryParserWorkerEntrypoint,
  supportsTsxImportWorker,
  type InProcessSummaryParser,
} from "../../src/sessions/summary-parser-worker-client.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type {
  SummaryParserClientEvent,
  SummaryParserWorkerRequest,
} from "../../src/sessions/summary-parser-worker-protocol.js";
import { runSummaryParserWorkerRequest } from "../../src/sessions/summary-parser-worker-runner.js";
import type { SessionSummary } from "../../src/supervisor/types.js";
import { getLogger } from "../../src/logging/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");
const sourceWorkerSupported = supportsTsxImportWorker(process.versions.node);
const itIfSourceWorker = sourceWorkerSupported ? it : it.skip;

async function fileStats(filePath: string) {
  const stats = await stat(filePath);
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    mtimeIso: stats.mtime.toISOString(),
  };
}

function sourceEntrypoint() {
  return resolveSummaryParserWorkerEntrypoint({
    runtime: "source",
    baseDir: join(packageRoot, "src", "sessions"),
  });
}

function fakeSummary(request: SummaryParserWorkerRequest): SessionSummary {
  return {
    id: request.sessionId,
    projectId: request.projectId,
    title: "fallback summary",
    fullTitle: "fallback summary",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: request.provider === "codex" ? "codex" : "claude",
  };
}

async function writeClaudeSummaryFixture(options: {
  filePath: string;
  message: string;
  assistantText?: string;
}): Promise<void> {
  const now = "2026-06-30T00:00:00.000Z";
  const later = "2026-06-30T00:00:01.000Z";
  await writeFile(
    options.filePath,
    `${[
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        timestamp: now,
        message: {
          content: options.message,
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: later,
        message: {
          model: "claude-sonnet-4-5",
          content: [
            {
              type: "text",
              text: options.assistantText ?? "Parsed by worker.",
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        },
      }),
    ].join("\n")}\n`,
  );
}

async function writeCodexSummaryFixture(options: {
  filePath: string;
  sessionId: string;
  projectPath: string;
  message: string;
}): Promise<void> {
  const now = "2026-06-30T00:00:00.000Z";
  await writeFile(
    options.filePath,
    `${[
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: options.sessionId,
          cwd: options.projectPath,
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: options.message,
        },
      }),
    ].join("\n")}\n`,
  );
}

describe("summary parser worker harness", () => {
  let testDir: string;
  let dataDir: string;
  let client: SummaryParserClient | null;

  beforeEach(async () => {
    testDir = join(tmpdir(), `summary-parser-worker-${randomUUID()}`);
    dataDir = join(testDir, "ya-data");
    await mkdir(testDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    vi.spyOn(getLogger(), "debug").mockImplementation(() => undefined);
    vi.spyOn(getLogger(), "info").mockImplementation(() => undefined);
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    client = null;
  });

  afterEach(async () => {
    await client?.close();
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("guards source tsx workers to Node 20.6 and later", () => {
    expect(supportsTsxImportWorker("20.5.1")).toBe(false);
    expect(supportsTsxImportWorker("20.6.0")).toBe(true);
    expect(supportsTsxImportWorker("21.0.0")).toBe(true);
    expect(supportsTsxImportWorker("v25.8.2")).toBe(true);
  });

  it("resolves built worker entrypoint without tsx exec args", () => {
    const entrypoint = resolveSummaryParserWorkerEntrypoint({
      runtime: "built",
      baseDir: join(packageRoot, "dist", "sessions"),
    });

    expect(entrypoint.supported).toBe(true);
    if (!entrypoint.supported) return;
    expect(entrypoint.runtime).toBe("built");
    expect(entrypoint.execArgv).toEqual([]);
    expect(
      entrypoint.modulePath.endsWith("summary-parser-worker-entry.js"),
    ).toBe(true);
  });

  itIfSourceWorker("reuses one child for ordinary parses", async () => {
    const firstSessionId = "reuse-worker-session-a";
    const secondSessionId = "reuse-worker-session-b";
    const firstPath = join(testDir, `${firstSessionId}.jsonl`);
    const secondPath = join(testDir, `${secondSessionId}.jsonl`);
    await writeClaudeSummaryFixture({
      filePath: firstPath,
      message: "First ordinary parse",
    });
    await writeClaudeSummaryFixture({
      filePath: secondPath,
      message: "Second ordinary parse",
    });
    client = new SummaryParserClient({
      mode: "required",
      cwd: packageRoot,
      entrypoint: sourceEntrypoint(),
      timeoutMs: 15_000,
      launchTimeoutMs: 10_000,
    });

    const first = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: firstPath,
      sessionId: firstSessionId,
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(firstPath),
    });
    const second = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: secondPath,
      sessionId: secondSessionId,
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(secondPath),
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(second.response?.metrics.workerPid).toBe(
      first.response?.metrics.workerPid,
    );
    expect(second.response?.metrics.workerParsedFiles).toBe(2);
    expect(second.response?.metrics.recycleRecommended).toBeUndefined();
  });

  itIfSourceWorker("serializes concurrent parses on one child", async () => {
    const warmSessionId = "serialized-worker-session-warm";
    const firstSessionId = "serialized-worker-session-a";
    const secondSessionId = "serialized-worker-session-b";
    const warmPath = join(testDir, `${warmSessionId}.jsonl`);
    const firstPath = join(testDir, `${firstSessionId}.jsonl`);
    const secondPath = join(testDir, `${secondSessionId}.jsonl`);
    await writeClaudeSummaryFixture({
      filePath: warmPath,
      message: "Warm worker parse",
    });
    await writeClaudeSummaryFixture({
      filePath: firstPath,
      message: "First concurrent parse",
    });
    await writeClaudeSummaryFixture({
      filePath: secondPath,
      message: "Second concurrent parse",
    });
    const events: SummaryParserClientEvent[] = [];
    client = new SummaryParserClient({
      mode: "required",
      cwd: packageRoot,
      entrypoint: sourceEntrypoint(),
      onEvent: (event) => events.push(event),
      timeoutMs: 15_000,
      launchTimeoutMs: 10_000,
    });
    const projectId = "worker-project" as UrlProjectId;
    const warm = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: warmPath,
      sessionId: warmSessionId,
      projectId,
      stats: await fileStats(warmPath),
    });
    expect(warm.status).toBe("ok");

    const firstRequest: SummaryParserWorkerRequest = {
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: firstPath,
      sessionId: firstSessionId,
      projectId,
      stats: await fileStats(firstPath),
    };
    const secondRequest: SummaryParserWorkerRequest = {
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: secondPath,
      sessionId: secondSessionId,
      projectId,
      stats: await fileStats(secondPath),
    };

    const [first, second] = await Promise.all([
      client.parse(firstRequest),
      client.parse(secondRequest),
    ]);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(first.response?.metrics.workerPid).toBe(
      warm.response?.metrics.workerPid,
    );
    expect(second.response?.metrics.workerPid).toBe(
      warm.response?.metrics.workerPid,
    );
    expect(first.response?.metrics.workerParsedFiles).toBe(2);
    expect(second.response?.metrics.workerParsedFiles).toBe(3);
    expect(
      events.filter(
        (event) =>
          event.event === "summary_parser_worker_result" &&
          event.status === "crash",
      ),
    ).toEqual([]);
  });

  itIfSourceWorker("recycles the child after a large-line parse", async () => {
    const largeSessionId = "large-line-worker-session";
    const nextSessionId = "after-large-line-worker-session";
    const largePath = join(testDir, `${largeSessionId}.jsonl`);
    const nextPath = join(testDir, `${nextSessionId}.jsonl`);
    await writeClaudeSummaryFixture({
      filePath: largePath,
      message: `This title is intentionally long enough to cross the test recycle threshold. ${"x".repeat(1_000)}`,
    });
    await writeClaudeSummaryFixture({
      filePath: nextPath,
      message: "Next parse after recycle",
    });
    client = new SummaryParserClient({
      mode: "required",
      cwd: packageRoot,
      entrypoint: sourceEntrypoint(),
      recycleAfterLineBytes: 512,
      timeoutMs: 15_000,
      launchTimeoutMs: 10_000,
    });

    const first = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: largePath,
      sessionId: largeSessionId,
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(largePath),
    });
    const second = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: nextPath,
      sessionId: nextSessionId,
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(nextPath),
    });

    expect(first.status).toBe("ok");
    expect(first.response?.metrics.recycleRecommended).toBe(true);
    expect(first.response?.metrics.recycleReason).toBe("large_line");
    expect(second.status).toBe("ok");
    expect(second.response?.metrics.workerPid).not.toBe(
      first.response?.metrics.workerPid,
    );
    expect(second.response?.metrics.workerParsedFiles).toBe(1);
    expect(second.response?.metrics.recycleRecommended).toBeUndefined();
  });

  itIfSourceWorker(
    "recycles the child after a cumulative byte budget",
    async () => {
      const firstSessionId = "byte-budget-worker-session-a";
      const secondSessionId = "byte-budget-worker-session-b";
      const firstPath = join(testDir, `${firstSessionId}.jsonl`);
      const secondPath = join(testDir, `${secondSessionId}.jsonl`);
      await writeClaudeSummaryFixture({
        filePath: firstPath,
        message: "Byte budget parse",
      });
      await writeClaudeSummaryFixture({
        filePath: secondPath,
        message: "After byte budget recycle",
      });
      client = new SummaryParserClient({
        mode: "required",
        cwd: packageRoot,
        entrypoint: sourceEntrypoint(),
        recycleAfterBytes: 1,
        recycleAfterLineBytes: 1024 * 1024,
        timeoutMs: 15_000,
        launchTimeoutMs: 10_000,
      });

      const first = await client.parse({
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath: firstPath,
        sessionId: firstSessionId,
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(firstPath),
      });
      const second = await client.parse({
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath: secondPath,
        sessionId: secondSessionId,
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(secondPath),
      });

      expect(first.status).toBe("ok");
      expect(first.response?.metrics.recycleRecommended).toBe(true);
      expect(first.response?.metrics.recycleReason).toBe("byte_budget");
      expect(second.status).toBe("ok");
      expect(second.response?.metrics.workerPid).not.toBe(
        first.response?.metrics.workerPid,
      );
    },
  );

  it("returns a timeout response when the worker hangs", async () => {
    const workerPath = join(testDir, "hanging-worker.js");
    await writeFile(
      workerPath,
      [
        'process.send?.({ type: "ready", pid: process.pid, nodeVersion: process.version });',
        'process.on("message", () => {});',
      ].join("\n"),
    );
    const filePath = join(testDir, "timeout-session.jsonl");
    await writeClaudeSummaryFixture({
      filePath,
      message: "Timeout parse",
    });
    client = new SummaryParserClient({
      mode: "required",
      entrypoint: {
        supported: true,
        runtime: "built",
        modulePath: workerPath,
        execArgv: [],
      },
      timeoutMs: 50,
      launchTimeoutMs: 1_000,
    });

    const result = await client.parse({
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath,
      sessionId: "timeout-session",
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(filePath),
    });

    expect(result.status).toBe("timeout");
    expect(result.response?.metrics.recycleRecommended).toBe(true);
    expect(result.response?.metrics.recycleReason).toBe("timeout");
    expect(result.error?.name).toBe("TimeoutError");
  });

  it("does not fall back in on mode when the worker returns a parse error", async () => {
    const workerPath = join(testDir, "error-worker.js");
    await writeFile(
      workerPath,
      [
        'process.send?.({ type: "ready", pid: process.pid, nodeVersion: process.version });',
        'process.on("message", (request) => {',
        "  process.send?.({",
        '    type: "result",',
        "    requestId: request.requestId,",
        '    status: "error",',
        "    summary: null,",
        "    metrics: {",
        "      provider: request.provider,",
        "      sessionId: request.sessionId,",
        "      filePath: request.filePath,",
        "      fileSize: request.stats.size,",
        "      fileMtimeMs: request.stats.mtimeMs,",
        "      workerPid: process.pid,",
        "      nodeVersion: process.version,",
        "      durationMs: 0,",
        "      heapUsedBefore: 0,",
        "      heapUsedAfter: 0,",
        "      rssBefore: 0,",
        "      rssAfter: 0,",
        "    },",
        '    error: { name: "Error", message: "worker parse exploded" },',
        "  });",
        "});",
      ].join("\n"),
    );
    const filePath = join(testDir, "worker-error-session.jsonl");
    await writeClaudeSummaryFixture({
      filePath,
      message: "Worker error should not fallback",
    });
    client = new SummaryParserClient({
      mode: "on",
      entrypoint: {
        supported: true,
        runtime: "built",
        modulePath: workerPath,
        execArgv: [],
      },
      launchTimeoutMs: 1_000,
    });
    let fallbackCalled = false;

    const result = await client.parse(
      {
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath,
        sessionId: "worker-error-session",
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(filePath),
      },
      async (request) => {
        fallbackCalled = true;
        return fakeSummary(request);
      },
    );

    expect(result.source).toBe("worker");
    expect(result.status).toBe("error");
    expect(result.summary).toBeNull();
    expect(result.error?.message).toBe("worker parse exploded");
    expect(fallbackCalled).toBe(false);
  });

  it("does not fall back in on mode when an active worker times out", async () => {
    const workerPath = join(testDir, "hanging-on-worker.js");
    await writeFile(
      workerPath,
      [
        'process.send?.({ type: "ready", pid: process.pid, nodeVersion: process.version });',
        'process.on("message", () => {});',
      ].join("\n"),
    );
    const filePath = join(testDir, "timeout-on-session.jsonl");
    await writeClaudeSummaryFixture({
      filePath,
      message: "Timeout on mode should not fallback",
    });
    client = new SummaryParserClient({
      mode: "on",
      entrypoint: {
        supported: true,
        runtime: "built",
        modulePath: workerPath,
        execArgv: [],
      },
      timeoutMs: 50,
      launchTimeoutMs: 1_000,
    });
    let fallbackCalled = false;

    const result = await client.parse(
      {
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath,
        sessionId: "timeout-on-session",
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(filePath),
      },
      async (request) => {
        fallbackCalled = true;
        return fakeSummary(request);
      },
    );

    expect(result.source).toBe("worker");
    expect(result.status).toBe("timeout");
    expect(result.response?.metrics.recycleRecommended).toBe(true);
    expect(result.response?.metrics.recycleReason).toBe("timeout");
    expect(fallbackCalled).toBe(false);
  });

  itIfSourceWorker(
    "parses a Claude fixture through a source worker",
    async () => {
      const sessionId = "claude-worker-session";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      const now = "2026-06-30T00:00:00.000Z";
      const later = "2026-06-30T00:00:01.000Z";
      await writeFile(
        filePath,
        `${[
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: now,
            message: {
              content: "Explain the worker harness",
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            parentUuid: "user-1",
            timestamp: later,
            message: {
              model: "claude-sonnet-4-5",
              content: [{ type: "text", text: "It isolates parsing." }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
              },
            },
          }),
        ].join("\n")}\n`,
      );

      client = new SummaryParserClient({
        mode: "required",
        cwd: packageRoot,
        entrypoint: sourceEntrypoint(),
        timeoutMs: 15_000,
        launchTimeoutMs: 10_000,
      });

      const request: SummaryParserWorkerRequest = {
        type: "parse",
        requestId: randomUUID(),
        provider: "claude",
        filePath,
        sessionId,
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(filePath),
      };
      const result = await client.parse(request);

      expect(result.source).toBe("worker");
      expect(result.status).toBe("ok");
      expect(result.summary?.title).toBe("Explain the worker harness");
      expect(result.summary?.messageCount).toBe(2);
      expect(result.response?.metrics.workerPid).not.toBe(process.pid);
    },
  );

  itIfSourceWorker(
    "parses a Codex fixture through a source worker",
    async () => {
      const sessionId = "codex-worker-session";
      const projectPath = "/test/project";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      await writeCodexSummaryFixture({
        filePath,
        sessionId,
        projectPath,
        message: "Hello from Codex",
      });

      client = new SummaryParserClient({
        mode: "required",
        cwd: packageRoot,
        entrypoint: sourceEntrypoint(),
        timeoutMs: 15_000,
        launchTimeoutMs: 10_000,
      });

      const request: SummaryParserWorkerRequest = {
        type: "parse",
        requestId: randomUUID(),
        provider: "codex",
        filePath,
        sessionId,
        projectId: "worker-project" as UrlProjectId,
        stats: await fileStats(filePath),
        sourceHints: {
          codex: {
            sessionsDir: testDir,
            projectPath,
            dataDir,
          },
        },
      };
      const result = await client.parse(request);

      expect(result.source).toBe("worker");
      expect(result.status).toBe("ok");
      expect(result.summary?.title).toBe("Hello from Codex");
      expect(result.summary?.provider).toBe("codex");
      expect(result.response?.metrics.lineCount).toBe(3);
    },
  );

  it("falls back in on mode when the worker is unsupported", async () => {
    const events: SummaryParserClientEvent[] = [];
    client = new SummaryParserClient({
      mode: "on",
      entrypoint: {
        supported: false,
        runtime: "source",
        reason: "source worker requires Node >=20.6",
      },
      onEvent: (event) => events.push(event),
    });
    const fallback: InProcessSummaryParser = async (request) =>
      fakeSummary(request);
    const request: SummaryParserWorkerRequest = {
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: join(testDir, "missing.jsonl"),
      sessionId: "fallback-session",
      projectId: "worker-project" as UrlProjectId,
      stats: { size: 0, mtimeMs: 0 },
    };

    const result = await client.parse(request, fallback);

    expect(result.source).toBe("fallback");
    expect(result.status).toBe("fallback");
    expect(result.summary?.title).toBe("fallback summary");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "summary_parser_worker_fallback",
        fallbackReason: "source worker requires Node >=20.6",
      }),
    );
  });

  it("does not fall back in required mode when the worker is unsupported", async () => {
    client = new SummaryParserClient({
      mode: "required",
      entrypoint: {
        supported: false,
        runtime: "source",
        reason: "source worker requires Node >=20.6",
      },
    });
    const request: SummaryParserWorkerRequest = {
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath: join(testDir, "missing.jsonl"),
      sessionId: "required-session",
      projectId: "worker-project" as UrlProjectId,
      stats: { size: 0, mtimeMs: 0 },
    };

    await expect(
      client.parse(request, async () => fakeSummary(request)),
    ).rejects.toThrow("source worker requires Node >=20.6");
  });

  it("can run the same parser in-process for explicit fallback", async () => {
    const sessionId = "in-process-session";
    const filePath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-1",
        timestamp: "2026-06-30T00:00:00.000Z",
        message: { content: "Fallback parse" },
      })}\n`,
    );
    const request: SummaryParserWorkerRequest = {
      type: "parse",
      requestId: randomUUID(),
      provider: "claude",
      filePath,
      sessionId,
      projectId: "worker-project" as UrlProjectId,
      stats: await fileStats(filePath),
    };

    const response = await runSummaryParserWorkerRequest(request);

    expect(response.status).toBe("ok");
    expect(response.summary?.title).toBe("Fallback parse");
    expect(response.metrics.workerPid).toBe(process.pid);
  });

  it("closes reader-owned summary parser clients", async () => {
    const claudeClose = vi.fn(async () => {});
    const codexClose = vi.fn(async () => {});
    const claudeReader = new ClaudeSessionReader({
      sessionDir: testDir,
      summaryParserWorkerMode: "on",
      summaryParserClient: {
        close: claudeClose,
      } as unknown as SummaryParserClient,
    });
    const codexReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "/test/project",
      dataDir,
      summaryParserWorkerMode: "on",
      summaryParserClient: {
        close: codexClose,
      } as unknown as SummaryParserClient,
    });

    await claudeReader.close();
    await claudeReader.close();
    await codexReader.close();
    await codexReader.close();

    expect(claudeClose).toHaveBeenCalledTimes(1);
    expect(codexClose).toHaveBeenCalledTimes(1);
  });

  itIfSourceWorker(
    "routes ClaudeSessionReader summaries through the worker",
    async () => {
      const sessionId = "reader-worker-session";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-06-30T00:00:00.000Z",
          message: { content: "Reader worker parse" },
        })}\n`,
      );
      const events: SummaryParserClientEvent[] = [];
      client = new SummaryParserClient({
        mode: "required",
        cwd: packageRoot,
        entrypoint: sourceEntrypoint(),
        onEvent: (event) => events.push(event),
        timeoutMs: 15_000,
        launchTimeoutMs: 10_000,
      });
      const reader = new ClaudeSessionReader({
        sessionDir: testDir,
        summaryParserWorkerMode: "required",
        summaryParserClient: client,
      });

      const summary = await reader.getSessionSummary(
        sessionId,
        "worker-project" as UrlProjectId,
      );

      expect(summary?.title).toBe("Reader worker parse");
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "summary_parser_worker_result",
          status: "ok",
        }),
      );
    },
  );

  it("falls back from ClaudeSessionReader on worker setup failure in on mode", async () => {
    const sessionId = "reader-fallback-session";
    const filePath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-1",
        timestamp: "2026-06-30T00:00:00.000Z",
        message: { content: "Reader fallback parse" },
      })}\n`,
    );
    const events: SummaryParserClientEvent[] = [];
    client = new SummaryParserClient({
      mode: "on",
      entrypoint: {
        supported: false,
        runtime: "source",
        reason: "source worker requires Node >=20.6",
      },
      onEvent: (event) => events.push(event),
    });
    const reader = new ClaudeSessionReader({
      sessionDir: testDir,
      summaryParserWorkerMode: "on",
      summaryParserClient: client,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "worker-project" as UrlProjectId,
    );

    expect(summary?.title).toBe("Reader fallback parse");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "summary_parser_worker_fallback",
        fallbackReason: "source worker requires Node >=20.6",
      }),
    );
  });

  itIfSourceWorker(
    "routes CodexSessionReader summaries through the worker",
    async () => {
      const sessionId = "codex-reader-worker-session";
      const projectPath = "/test/project";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      await writeCodexSummaryFixture({
        filePath,
        sessionId,
        projectPath,
        message: "Codex reader worker parse",
      });
      const events: SummaryParserClientEvent[] = [];
      client = new SummaryParserClient({
        mode: "required",
        cwd: packageRoot,
        entrypoint: sourceEntrypoint(),
        onEvent: (event) => events.push(event),
        timeoutMs: 15_000,
        launchTimeoutMs: 10_000,
      });
      const reader = new CodexSessionReader({
        sessionsDir: testDir,
        projectPath,
        dataDir,
        summaryParserWorkerMode: "required",
        summaryParserClient: client,
      });

      const summary = await reader.getSessionSummary(
        sessionId,
        "worker-project" as UrlProjectId,
      );

      expect(summary?.title).toBe("Codex reader worker parse");
      expect(summary?.provider).toBe("codex");
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "summary_parser_worker_result",
          provider: "codex",
          status: "ok",
        }),
      );
    },
  );

  it("falls back from CodexSessionReader on worker setup failure in on mode", async () => {
    const sessionId = "codex-reader-fallback-session";
    const projectPath = "/test/project";
    const filePath = join(testDir, `${sessionId}.jsonl`);
    await writeCodexSummaryFixture({
      filePath,
      sessionId,
      projectPath,
      message: "Codex reader fallback parse",
    });
    const events: SummaryParserClientEvent[] = [];
    client = new SummaryParserClient({
      mode: "on",
      entrypoint: {
        supported: false,
        runtime: "source",
        reason: "source worker requires Node >=20.6",
      },
      onEvent: (event) => events.push(event),
    });
    const reader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath,
      dataDir,
      summaryParserWorkerMode: "on",
      summaryParserClient: client,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "worker-project" as UrlProjectId,
    );

    expect(summary?.title).toBe("Codex reader fallback parse");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "summary_parser_worker_fallback",
        provider: "codex",
        fallbackReason: "source worker requires Node >=20.6",
      }),
    );
  });
});
