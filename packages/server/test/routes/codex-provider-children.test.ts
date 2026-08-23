import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  createSessionsRoutes,
  type SessionsDeps,
} from "../../src/routes/sessions.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";

const PROJECT_PATH = "/test/codex-provider-children";

function line(type: string, payload: unknown, timestamp: string): string {
  return JSON.stringify({ type, timestamp, payload });
}

function sessionMeta(
  id: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return line(
    "session_meta",
    {
      id,
      cwd: PROJECT_PATH,
      timestamp,
      model_provider: "openai",
      ...extra,
    },
    timestamp,
  );
}

async function writeRollout(
  sessionsDir: string,
  id: string,
  lines: string[],
): Promise<void> {
  const dateDir = join(sessionsDir, "2026", "06", "25");
  await mkdir(dateDir, { recursive: true });
  await writeFile(
    join(dateDir, `rollout-${id}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

function emptyReader(): ISessionReader {
  return {
    getSessionSummary: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    getAgentMappings: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => null),
  } as unknown as ISessionReader;
}

describe("Codex provider child route contract", () => {
  let sessionsDir: string;
  let isolatedProviderDir: string;

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-child-routes-${randomUUID()}`);
    isolatedProviderDir = join(tmpdir(), `codex-child-other-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(isolatedProviderDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(isolatedProviderDir, { recursive: true, force: true });
  });

  it("feeds metadata and the nested agent page from a child rollout", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "route-parent-thread";
    const childId = "route-child-thread";
    const callId = "call-route-spawn";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use a subagent" }],
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the nested page",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({
            agent_id: childId,
            nickname: "Nested page",
          }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: {
          subagent: { thread_spawn: { parent_thread_id: parentId } },
        },
      }),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child rollout" }],
        },
        now,
      ),
      line(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "Child rollout",
        },
        now,
      ),
    ]);

    const projectId = encodeProjectId(PROJECT_PATH);
    const project: Project = {
      id: projectId,
      path: PROJECT_PATH,
      name: "codex-children",
      sessionCount: 1,
      sessionDir: sessionsDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "codex",
    };
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getProject: vi.fn(async () => project),
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: () => emptyReader(),
      codexSessionsDir: sessionsDir,
      codexReaderFactory: () => reader,
      grokSessionsDir: isolatedProviderDir,
      piSessionsDir: isolatedProviderDir,
    });

    const metadataResponse = await routes.request(
      `/projects/${projectId}/sessions/${parentId}/metadata`,
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      session: {
        id: parentId,
        provider: "codex",
        providerChildren: [
          expect.objectContaining({
            id: childId,
            parentSessionId: parentId,
            title: "Nested page",
            toolUseId: callId,
          }),
        ],
      },
    });

    const agentResponse = await routes.request(
      `/projects/${projectId}/sessions/${parentId}/agents/${childId}`,
    );
    expect(agentResponse.status).toBe(200);
    await expect(agentResponse.json()).resolves.toMatchObject({
      status: "completed",
      messages: [
        expect.objectContaining({
          type: "assistant",
          isSubagent: true,
        }),
        expect.objectContaining({
          type: "system",
          subtype: "turn_complete",
          codexTurnId: "turn-child",
          isSubagent: true,
        }),
      ],
    });
  });
});
