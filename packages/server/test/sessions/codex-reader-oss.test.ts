import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { SummaryParserClient } from "../../src/sessions/summary-parser-worker-client.js";
import { isZstdJsonlSupported } from "../../src/utils/jsonl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const zstdCompressSync = (
  zlib as typeof zlib & {
    zstdCompressSync?: (buffer: Buffer) => Buffer;
  }
).zstdCompressSync;
const hasNativeZstd =
  typeof zstdCompressSync === "function" && isZstdJsonlSupported();
const itIfNativeZstd = hasNativeZstd ? it : it.skip;
const itIfNoNativeZstd = hasNativeZstd ? it.skip : it;

function zstdCompressed(content: string): Buffer {
  if (!zstdCompressSync) {
    throw new Error("zstd compression is unavailable in this Node.js");
  }
  return zstdCompressSync(Buffer.from(content, "utf-8"));
}

describe("CodexSessionReader - OSS Support", () => {
  let testDir: string;
  let reader: CodexSessionReader;
  let extraTempDirs: string[];

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-reader-oss-test-${randomUUID()}`);
    extraTempDirs = [];
    await mkdir(testDir, { recursive: true });
    reader = new CodexSessionReader({ sessionsDir: testDir });
  });

  afterEach(async () => {
    await Promise.all(
      [testDir, ...extraTempDirs].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const createSessionFile = async (
    sessionId: string,
    provider: string | undefined,
    model: string | undefined,
    originator?: string,
    tokenUsage?: {
      totalInputTokens: number;
      totalCachedInputTokens?: number;
      lastInputTokens?: number;
      lastCachedInputTokens?: number;
      modelContextWindow?: number;
    },
  ) => {
    const metaPayload = {
      id: sessionId,
      cwd: "/test/project",
      timestamp: new Date().toISOString(),
      ...(provider ? { model_provider: provider } : {}),
      ...(originator ? { originator } : {}),
    };

    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: metaPayload,
      }),
    ];

    if (model) {
      lines.push(
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date().toISOString(),
          payload: { model },
        }),
      );
    }

    // Add a user message so it's a valid session with messages
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      }),
    );

    if (tokenUsage) {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: tokenUsage.totalInputTokens,
                cached_input_tokens: tokenUsage.totalCachedInputTokens ?? 0,
                output_tokens: 10,
                total_tokens: tokenUsage.totalInputTokens + 10,
              },
              ...(tokenUsage.lastInputTokens !== undefined && {
                last_token_usage: {
                  input_tokens: tokenUsage.lastInputTokens,
                  cached_input_tokens: tokenUsage.lastCachedInputTokens ?? 0,
                  output_tokens: 5,
                  total_tokens: tokenUsage.lastInputTokens + 5,
                },
              }),
              model_context_window: tokenUsage.modelContextWindow ?? 258400,
            },
          },
        }),
      );
    }

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  };

  it("identifies session as codex-oss when model_provider is ollama", async () => {
    const sessionId = "oss-session-1";
    await createSessionFile(sessionId, "ollama", "mistral");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.provider).toBe("codex-oss");
  });

  it("does not retain full entries for summary-only reads", async () => {
    const sessionId = "summary-cache-session";
    await createSessionFile(sessionId, "openai", "gpt-5");

    expect(reader.getEntryCacheStats().sessions).toBe(0);

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.id).toBe(sessionId);
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 0,
      entries: 0,
      sourceBytes: 0,
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.session.entries.length).toBeGreaterThan(0);
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 1,
      sourceBytes: expect.any(Number),
    });
  });

  it("streams summary state without full entry retention", async () => {
    const sessionId = "summary-stream-session";
    const now = new Date().toISOString();
    const responseUser = {
      type: "response_item",
      timestamp: now,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "response title" }],
      },
    };
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          forked_from_id: "parent-session",
          model_provider: "local",
          originator: "yep-anywhere",
          cli_version: "1.2.3",
          source: "exec",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "on-request",
          sandbox_policy: {
            type: "workspace-write",
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: true,
          },
          model: "gpt-4o",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>\nignored" },
          ],
        },
      }),
      JSON.stringify(responseUser),
      JSON.stringify(responseUser),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "response title",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          model: "qwen2.5-coder",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 0,
              output_tokens: 10,
              total_tokens: 130,
            },
            model_context_window: 1000,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
            model_context_window: 1000,
          },
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary).toMatchObject({
      id: sessionId,
      title: "response title",
      fullTitle: "response title",
      messageCount: 2,
      provider: "codex-oss",
      model: "qwen2.5-coder",
      forkedFromSessionId: "parent-session",
      originator: "yep-anywhere",
      cliVersion: "1.2.3",
      source: "exec",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspace-write",
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
      contextUsage: {
        inputTokens: 120,
        percentage: 12,
        contextWindow: 1000,
      },
    });
    expect(reader.getEntryCacheStats()).toMatchObject({
      sessions: 0,
      entries: 0,
      sourceBytes: 0,
    });
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      sessionId,
      compressed: false,
      lineCount: lines.length,
      parsedEntries: lines.length,
      dedupedEntries: lines.length - 1,
      skippedDuplicateEntries: 1,
      entryCache: {
        sessions: 0,
        entries: 0,
        sourceBytes: 0,
      },
    });

    const full = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(full?.summary).toMatchObject({
      title: summary?.title,
      fullTitle: summary?.fullTitle,
      messageCount: summary?.messageCount,
      provider: summary?.provider,
      model: summary?.model,
      forkedFromSessionId: summary?.forkedFromSessionId,
      contextUsage: summary?.contextUsage,
    });
  });

  it("skips plugin-prefixed startup instructions when deriving titles", async () => {
    const sessionId = "plugin-prefixed-startup-title";
    const now = new Date().toISOString();
    const startupInstructions = [
      "<recommended_plugins>",
      "- GitHub (github@openai-curated-remote)",
      "</recommended_plugins>",
      "# AGENTS.md instructions for /test/project",
      "<INSTRUCTIONS>",
      "Follow the project instructions.",
      "</INSTRUCTIONS>",
    ].join("\n");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: startupInstructions }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "actual first turn" }],
        },
      }),
    ];
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const headSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );
    expect(headSummary).toMatchObject({
      title: "actual first turn",
      fullTitle: "actual first turn",
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.summary).toMatchObject({
      title: "actual first turn",
      fullTitle: "actual first turn",
    });
  });

  it("uses user-turn provenance when plugins are followed by environment", async () => {
    const sessionId = "plugin-environment-startup-title";
    const now = new Date().toISOString();
    const actualPrompt = "actual first turn";
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
          cli_version: "0.144.1",
          originator: "yep-anywhere",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: actualPrompt }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: { type: "user_message", message: actualPrompt },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const headSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );
    expect(headSummary).toMatchObject({
      title: actualPrompt,
      fullTitle: actualPrompt,
      messageCount: 1,
    });

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.summary).toMatchObject({
      title: actualPrompt,
      fullTitle: actualPrompt,
      messageCount: 2,
    });
  });

  it("can read a cheap head summary without scanning trailing transcript", async () => {
    const sessionId = "cheap-summary-session";
    const now = new Date().toISOString();
    const trailingMessages = Array.from({ length: 250 }, (_, index) =>
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `bulk ${index}` }],
        },
      }),
    );
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          model: "gpt-5",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "cheap summary title",
        },
      }),
      ...trailingMessages,
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          model: "late-model",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 0,
              output_tokens: 10,
              total_tokens: 910,
            },
            model_context_window: 1000,
          },
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const cheap = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
      { readMode: "head" },
    );

    expect(cheap).toMatchObject({
      id: sessionId,
      title: "cheap summary title",
      fullTitle: "cheap summary title",
      messageCount: 1,
      provider: "codex",
      model: "gpt-5",
      approvalPolicy: "never",
    });
    expect(cheap?.contextUsage).toBeUndefined();
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      readMode: "head",
      lineCount: 3,
      parsedEntries: 3,
      stoppedEarly: true,
      stopReason: "head_complete",
    });

    const listSummary = await reader.getSessionListSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(listSummary).toMatchObject({
      id: sessionId,
      projectId: "test-project",
      title: "cheap summary title",
    });
    expect(Object.keys(listSummary ?? {}).sort()).toEqual([
      "fullTitle",
      "id",
      "projectId",
      "provider",
      "title",
      "updatedAt",
    ]);

    const full = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(full).toMatchObject({
      title: "cheap summary title",
      messageCount: 251,
      model: "late-model",
      contextUsage: {
        inputTokens: 900,
        percentage: 90,
        contextWindow: 1000,
      },
    });
    expect(reader.getLastSummaryStreamMetrics()).toMatchObject({
      event: "codex_summary_stream",
      readMode: "full",
      lineCount: lines.length,
      stoppedEarly: false,
      stopReason: "eof",
    });
  });

  it("coalesces full summary parses for the same Codex file version", async () => {
    const sessionId = "coalesced-full-summary";
    const filePath = join(testDir, `${sessionId}.jsonl`);
    const now = new Date().toISOString();
    await writeFile(
      filePath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Coalesce this full parse",
          },
        }),
      ].join("\n")}\n`,
    );

    let releaseParse!: () => void;
    const parseGate = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    let firstParseStarted!: () => void;
    const firstParseStart = new Promise<void>((resolve) => {
      firstParseStarted = resolve;
    });
    const parse = vi.fn<SummaryParserClient["parse"]>(
      async (request, inProcessParser) => {
        firstParseStarted();
        await parseGate;
        const summary = await inProcessParser?.(request);
        return {
          summary: summary ?? null,
          status: summary ? "ok" : "empty",
          source: "worker",
        };
      },
    );
    const coalescingReader = new CodexSessionReader({
      sessionsDir: testDir,
      summaryParserWorkerMode: "required",
      summaryParserClient: { parse } as unknown as SummaryParserClient,
    });
    const projectId = "test-project" as UrlProjectId;

    const first = coalescingReader.getSessionSummary(sessionId, projectId);
    await firstParseStart;
    const second = coalescingReader.getSessionSummary(sessionId, projectId);
    releaseParse();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(firstSummary?.title).toBe("Coalesce this full parse");
    expect(secondSummary?.title).toBe("Coalesce this full parse");
    expect(firstSummary).not.toBe(secondSummary);

    await coalescingReader.getSessionSummary(sessionId, projectId);
    expect(parse).toHaveBeenCalledTimes(1);

    await appendFile(
      filePath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "agent_message",
          message: "A new version should parse again.",
        },
      })}\n`,
    );
    await coalescingReader.getSessionSummary(sessionId, projectId);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  itIfNativeZstd("loads zstd-compressed rollout files", async () => {
    const sessionId = "zstd-rollout";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "Hello compressed history",
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl.zst`),
      zstdCompressed(`${lines.join("\n")}\n`),
    );

    const summaries = await reader.listSessions("test-project" as UrlProjectId);
    expect(summaries.map((summary) => summary.id)).toContain(sessionId);

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.summary.title).toBe("Hello compressed history");
    expect(session?.data.session.entries).toHaveLength(2);
  });

  itIfNoNativeZstd(
    "skips zstd-compressed rollouts without native zstd",
    async () => {
      const sessionId = "unsupported-zstd-rollout";
      const now = new Date().toISOString();
      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Hello compressed history",
          },
        }),
      ];

      await writeFile(
        join(testDir, `${sessionId}.jsonl.zst`),
        Buffer.from(`${lines.join("\n")}\n`),
      );

      await expect(
        reader.listSessions("test-project" as UrlProjectId),
      ).resolves.toEqual([]);

      const metrics = reader.getLastScanMetrics();
      expect(metrics).toMatchObject({
        compressedRolloutFiles: 1,
        sessionsParsed: 0,
        failedFiles: 1,
        sessionsReturned: 0,
        discovery: {
          zstdUnsupported: 1,
          firstLineReadsZstd: 0,
          metadataReadFailures: 0,
        },
      });

      await expect(
        reader.getSession(sessionId, "test-project" as UrlProjectId),
      ).resolves.toBeNull();
    },
  );

  it("records reader scan metrics and shared cache hits", async () => {
    const dataDir = join(tmpdir(), `codex-reader-data-${randomUUID()}`);
    extraTempDirs.push(dataDir);
    await createSessionFile("metrics-one", "openai", "gpt-4o");
    await createSessionFile("metrics-two", "openai", "gpt-4o");

    const metricsReader = new CodexSessionReader({
      sessionsDir: testDir,
      dataDir,
      slowLogThresholdMs: 60_000,
    });

    const files = await metricsReader.listSessionFiles(testDir);
    expect(files).toHaveLength(2);

    const missMetrics = metricsReader.getLastScanMetrics();
    expect(missMetrics).toMatchObject({
      sessionsDir: testDir,
      cacheKey: `${testDir}::activeAfter=all`,
      sharedCacheStatus: "miss",
      sessionsDirExists: true,
      rolloutFilesFound: 2,
      rolloutFilesAfterPrecedence: 2,
      plainRolloutFiles: 2,
      compressedRolloutFiles: 0,
      precedenceSkippedCompressed: 0,
      sessionsParsed: 2,
      failedFiles: 0,
      subagentSessionsSkipped: 0,
      sessionsReturned: 2,
      discovery: {
        statCalls: 2,
        discoveryIndexMisses: 2,
        firstLineReadsPlain: 2,
        metadataReadFailures: 0,
      },
    });
    expect(missMetrics?.directoriesVisited).toBeGreaterThanOrEqual(1);
    expect(missMetrics?.durationMs).toBeGreaterThanOrEqual(0);

    const cachedFiles = await metricsReader.listSessionFiles(testDir);
    expect(cachedFiles).toHaveLength(2);

    const hitMetrics = metricsReader.getLastScanMetrics();
    expect(hitMetrics).toMatchObject({
      sessionsDir: testDir,
      sharedCacheStatus: "hit",
      directoriesVisited: 0,
      rolloutFilesFound: 0,
      sessionsParsed: 0,
      failedFiles: 0,
      sessionsReturned: 2,
      discovery: {
        statCalls: 0,
        discoveryIndexHits: 0,
        firstLineReadsPlain: 0,
      },
    });
  });

  it("identifies session as codex-oss when model_provider is local", async () => {
    const sessionId = "oss-session-2";
    await createSessionFile(sessionId, "local", "deepseek-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("identifies session as codex when model_provider is openai", async () => {
    const sessionId = "openai-session-1";
    await createSessionFile(sessionId, "openai", "gpt-4o");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("falls back to codex-oss based on model name (llama)", async () => {
    const sessionId = "heuristic-session-1";
    await createSessionFile(sessionId, undefined, "llama-3-8b");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("falls back to codex-oss based on model name (qwen)", async () => {
    const sessionId = "heuristic-session-2";
    await createSessionFile(sessionId, undefined, "qwen2.5-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("defaults to codex when no provider and unknown model", async () => {
    const sessionId = "unknown-session";
    await createSessionFile(sessionId, undefined, "unknown-model");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("filters mixed-slash Windows cwd variants as the same project", async () => {
    const sessionId = "windows-mixed-slash";
    await createSessionFile(
      sessionId,
      "openai",
      "gpt-4o",
      undefined,
      undefined,
    );

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\kyle\\Documents\\webvam",
            timestamp: new Date().toISOString(),
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "user_message",
            message: "Hello world",
          },
        }),
      ].join("\n")}\n`,
    );

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "c:/Users/kyle/Documents/webvam",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/kyle/Documents/webvam"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(sessionId);
  });

  it("filters Windows cwd case variants as the same project", async () => {
    const upperSessionId = "windows-case-upper";
    const lowerSessionId = "windows-case-lower";
    const now = new Date().toISOString();
    for (const [sessionId, cwd] of [
      [upperSessionId, "C:/Users/sox/Documents/code/mclone"],
      [lowerSessionId, "c:/users/sox/documents/code/mclone"],
    ] as const) {
      await writeFile(
        join(testDir, `${sessionId}.jsonl`),
        `${[
          JSON.stringify({
            type: "session_meta",
            timestamp: now,
            payload: {
              id: sessionId,
              cwd,
              timestamp: now,
              model_provider: "openai",
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: now,
            payload: {
              type: "user_message",
              message: "Hello world",
            },
          }),
        ].join("\n")}\n`,
      );
    }

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "C:/Users/sox/Documents/code/mclone",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/sox/Documents/code/mclone"),
    );
    expect(summaries.map((summary) => summary.id).sort()).toEqual([
      lowerSessionId,
      upperSessionId,
    ]);
  });

  it("identifies codex based on model name (gpt-4)", async () => {
    const sessionId = "heuristic-openai";
    await createSessionFile(sessionId, undefined, "gpt-4-turbo");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("uses last_token_usage input_tokens for context usage", async () => {
    const sessionId = "context-last-usage";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 236_673,
      totalCachedInputTokens: 116_000,
      lastInputTokens: 120_000,
      lastCachedInputTokens: 118_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(120_000);
    expect(summary?.contextUsage?.percentage).toBe(47);
    expect(summary?.contextUsage?.contextWindow).toBe(258_000);
  });

  it("falls back to total_token_usage input_tokens when last_token_usage is absent", async () => {
    const sessionId = "context-total-fallback";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 85_000,
      totalCachedInputTokens: 40_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(85_000);
    expect(summary?.contextUsage?.percentage).toBe(33);
  });

  it("excludes developer messages from messageCount", async () => {
    const sessionId = "developer-filter";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.messageCount).toBe(1);
  });

  it("preserves originator from session metadata", async () => {
    const sessionId = "originator-passthrough";
    await createSessionFile(sessionId, "openai", "gpt-4o", "yep-anywhere");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.originator).toBe("yep-anywhere");
  });

  it("reuses cached Codex entries and parses appended JSONL", async () => {
    const sessionId = "append-cache";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "first",
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(first?.data.session.entries).toHaveLength(2);

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "second",
        },
      })}\n`,
    );

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(second?.data.session.entries).toHaveLength(3);
    expect(
      second?.data.session.entries.filter(
        (entry) =>
          entry.type === "event_msg" && entry.payload.type === "user_message",
      ),
    ).toHaveLength(2);
  });

  it("deduplicates exact cached Codex JSONL records", async () => {
    const sessionId = "duplicate-records";
    const now = new Date().toISOString();
    const sessionPath = join(testDir, `${sessionId}.jsonl`);
    const userMessage = {
      type: "response_item",
      timestamp: now,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "start here" }],
      },
    };
    await writeFile(
      sessionPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify(userMessage),
        JSON.stringify(userMessage),
      ].join("\n")}\n`,
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(loaded?.data.session.entries).toHaveLength(2);
    expect(
      loaded?.data.session.entries.filter(
        (entry) =>
          entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("does not expose the mutable Codex entry cache", async () => {
    const sessionId = "entry-cache-copy";
    const now = new Date().toISOString();
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: now,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first turn" }],
          },
        }),
      ].join("\n")}\n`,
    );

    const first = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    const duplicate = first?.data.session.entries[1];
    expect(duplicate).toBeDefined();
    if (duplicate) {
      first?.data.session.entries.push(duplicate);
    }

    const second = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(second?.data.session.entries).toHaveLength(2);
  });
});
