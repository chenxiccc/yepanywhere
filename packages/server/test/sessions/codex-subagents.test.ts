import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";

const PROJECT_PATH = "/test/project";

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
): Promise<string> {
  const dateDir = join(sessionsDir, "2026", "06", "25");
  await mkdir(dateDir, { recursive: true });
  const filePath = join(dateDir, `rollout-${id}.jsonl`);
  await writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("Codex subagent sessions", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = join(tmpdir(), `codex-subagents-${randomUUID()}`);
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("maps spawn_agent calls to child rollout sessions", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "parent-thread";
    const childId = "child-thread";
    const callId = "call-spawn-1";

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
            prompt: "Inspect the implementation",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: childId, nickname: "Parfit" }),
        },
        now,
      ),
    ]);

    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        session_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              agent_role: "reviewer",
            },
          },
        },
        agent_nickname: "Parfit",
        agent_role: "reviewer",
        multi_agent_version: "v2",
      }),
      line(
        "event_msg",
        {
          type: "task_started",
          turn_id: "turn-child",
          model_context_window: 200000,
          collaboration_mode_kind: "subagent",
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child result" }],
        },
        now,
      ),
      line(
        "event_msg",
        {
          type: "task_complete",
          turn_id: "turn-child",
          last_agent_message: "Child result",
        },
        now,
      ),
    ]);

    const projectId = encodeProjectId(PROJECT_PATH) as UrlProjectId;
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    const summaries = await reader.listSessions(projectId);
    expect(summaries.map((summary) => summary.id)).toEqual([parentId]);

    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 0,
      mappings: 0,
    });
    await expect(
      reader.getSession(parentId, projectId),
    ).resolves.not.toBeNull();
    expect(reader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });

    await expect(reader.getAgentMappings(parentId)).resolves.toEqual([
      { toolUseId: callId, agentId: childId },
    ]);
    const coldReader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });
    await expect(coldReader.getAgentMappings(parentId)).resolves.toEqual([
      { toolUseId: callId, agentId: childId },
    ]);
    expect(coldReader.getAgentMappingCacheStats()).toEqual({
      sessions: 1,
      mappings: 1,
    });
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual([
      {
        id: childId,
        parentSessionId: parentId,
        title: "Parfit",
        agentType: "reviewer",
        toolUseId: callId,
        updatedAt: now,
      },
    ]);

    const agentSession = await reader.getAgentSession(childId);
    expect(agentSession?.status).toBe("completed");
    expect(agentSession?.messages).toHaveLength(1);
    expect(agentSession?.messages[0]).toMatchObject({
      type: "assistant",
      isSubagent: true,
    });
    expect(agentSession?.messages[0]?.message?.content).toEqual([
      { type: "text", text: "Child result" },
    ]);
  });

  it("coalesces and incrementally refreshes bounded child projections", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "projection-parent";
    const firstChildId = "projection-child-1";
    const secondChildId = "projection-child-2";
    const firstCallId = "call-projection-1";
    const secondCallId = "call-projection-2";
    const ordinaryLines = Array.from({ length: 2_000 }, (_, index) =>
      line(
        "event_msg",
        { type: "agent_message", message: `ordinary-${index}` },
        now,
      ),
    );
    const parentPath = await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      ...ordinaryLines,
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: firstCallId,
          arguments: JSON.stringify({
            role: "reviewer",
            prompt: "Inspect the projection",
          }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: firstCallId,
          output: JSON.stringify({ agent_id: firstChildId }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, firstChildId, [
      sessionMeta(firstChildId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);

    const readers = Array.from(
      { length: 20 },
      () =>
        new CodexSessionReader({
          sessionsDir,
          projectPath: PROJECT_PATH,
        }),
    );
    const statsBefore = readers[0]!.getProviderChildProjectionCacheStats();
    const concurrent = await Promise.all(
      readers.map((reader) => reader.listProviderChildSessions(parentId)),
    );
    const statsAfter = readers[0]!.getProviderChildProjectionCacheStats();

    expect(concurrent.every((children) => children.length === 1)).toBe(true);
    expect(statsAfter.workStarts - statsBefore.workStarts).toBe(1);
    expect(
      statsAfter.joinedCalls -
        statsBefore.joinedCalls +
        (statsAfter.cacheHits - statsBefore.cacheHits),
    ).toBe(19);
    for (const reader of readers) {
      expect(reader.getEntryCacheStats()).toEqual({
        sessions: 0,
        entries: 0,
        sourceBytes: 0,
        partialLineBytes: 0,
      });
    }

    const reader = readers[0]!;
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "hit",
      sourceBytesRead: 0,
      childCount: 1,
    });

    const sizeBeforeOrdinaryAppend = (await stat(parentPath)).size;
    const ordinaryAppend = `${line(
      "event_msg",
      { type: "agent_message", message: "ordinary append" },
      now,
    )}\n`;
    await appendFile(parentPath, ordinaryAppend);
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeOrdinaryAppend,
      sourceBytesRead: Buffer.byteLength(ordinaryAppend),
      childCount: 1,
    });

    await writeRollout(sessionsDir, secondChildId, [
      sessionMeta(secondChildId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);
    const spawnAppend = line(
      "response_item",
      {
        type: "function_call",
        name: "spawn_agent",
        call_id: secondCallId,
        arguments: JSON.stringify({
          role: "explorer",
          prompt: "Map the callers",
        }),
      },
      now,
    );
    const sizeBeforeSpawnAppend = (await stat(parentPath)).size;
    await appendFile(parentPath, spawnAppend);
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeSpawnAppend,
      sourceBytesRead: Buffer.byteLength(spawnAppend),
      childCount: 1,
    });

    const outputAppend = `\n${line(
      "response_item",
      {
        type: "function_call_output",
        call_id: secondCallId,
        output: JSON.stringify({ agent_id: secondChildId, nickname: "Hume" }),
      },
      now,
    )}\n`;
    const sizeBeforeOutputAppend = (await stat(parentPath)).size;
    await appendFile(parentPath, outputAppend);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstChildId }),
        expect.objectContaining({
          id: secondChildId,
          title: "Hume",
          agentType: "explorer",
          toolUseId: secondCallId,
        }),
      ]),
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: false,
      startOffset: sizeBeforeOutputAppend,
      sourceBytesRead: Buffer.byteLength(outputAppend),
      childCount: 2,
    });

    const sizeBeforeReplacement = (await stat(parentPath)).size;
    const replacementHead = `${sessionMeta(parentId, now)}\n`;
    await writeFile(
      parentPath,
      `${replacementHead}${" ".repeat(
        sizeBeforeReplacement - Buffer.byteLength(replacementHead),
      )}`,
    );
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      [],
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: true,
      startOffset: 0,
      fileSize: sizeBeforeReplacement,
      childCount: 0,
    });

    await writeFile(parentPath, `${sessionMeta(parentId, now)}\n`);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual(
      [],
    );
    expect(reader.getLastProviderChildProjectionMetrics()).toMatchObject({
      status: "computed",
      fullRebuild: true,
      startOffset: 0,
      childCount: 0,
    });
  });

  it("serves accepted child state while a cold refresh runs", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "accepted-parent";
    const childId = "accepted-child";
    const callId = "call-accepted";
    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "function_call",
          name: "spawn_agent",
          call_id: callId,
          arguments: JSON.stringify({ prompt: "Inspect accepted state" }),
        },
        now,
      ),
      line(
        "response_item",
        {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ agent_id: childId }),
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
      }),
    ]);
    const reader = new CodexSessionReader({
      sessionsDir,
      projectPath: PROJECT_PATH,
    });

    expect(reader.listAcceptedProviderChildSessions(parentId)).toEqual([]);
    await expect(
      reader.listProviderChildSessions(parentId),
    ).resolves.toHaveLength(1);
    expect(reader.listAcceptedProviderChildSessions(parentId)).toEqual([
      expect.objectContaining({ id: childId, parentSessionId: parentId }),
    ]);
  });

  it("does not expose child rollouts as standalone Codex projects", async () => {
    const now = "2026-06-25T12:00:00.000Z";
    const parentId = "project-parent-thread";
    const childId = "project-child-thread";

    await writeRollout(sessionsDir, parentId, [
      sessionMeta(parentId, now),
      line(
        "response_item",
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Parent session" }],
        },
        now,
      ),
    ]);
    await writeRollout(sessionsDir, childId, [
      sessionMeta(childId, now, {
        parent_thread_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
            },
          },
        },
      }),
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Child session" }],
        },
        now,
      ),
    ]);

    const scanner = new CodexSessionScanner({ sessionsDir });
    const projects = await scanner.listProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: PROJECT_PATH,
      sessionCount: 1,
    });
  });
});
