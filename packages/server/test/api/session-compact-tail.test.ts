import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

describe("session detail compact-tail pagination", () => {
  const projectPath = "/home/user/myproject";
  const projectId = encodeProjectId(projectPath);
  let testDir: string;
  let codexSessionsDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `compact-tail-test-${randomUUID()}`);
    codexSessionsDir = join(testDir, "codex-sessions");
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");
    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeSession(name: string) {
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");
    const sessionDir = join(testDir, "localhost", encodedPath);
    const timestamp = (second: number) =>
      `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const entries = [
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u1",
        timestamp: timestamp(1),
        message: { role: "user", content: "u1" },
      },
      {
        type: "assistant",
        cwd: projectPath,
        sessionId: name,
        uuid: "a1",
        parentUuid: "u1",
        timestamp: timestamp(2),
        message: { role: "assistant", content: "a1" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        cwd: projectPath,
        sessionId: name,
        uuid: "cb1",
        logicalParentUuid: "a1",
        timestamp: timestamp(3),
        content: "Conversation compacted",
      },
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u2",
        parentUuid: "cb1",
        timestamp: timestamp(4),
        message: { role: "user", content: "u2" },
      },
      {
        type: "assistant",
        cwd: projectPath,
        sessionId: name,
        uuid: "a2",
        parentUuid: "u2",
        timestamp: timestamp(5),
        message: { role: "assistant", content: "a2" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        cwd: projectPath,
        sessionId: name,
        uuid: "cb2",
        logicalParentUuid: "a2",
        timestamp: timestamp(6),
        content: "Conversation compacted",
      },
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u3",
        parentUuid: "cb2",
        timestamp: timestamp(7),
        message: { role: "user", content: "u3" },
      },
    ];

    await writeFile(
      join(sessionDir, `${name}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  it("defaults exactly two compact boundaries to a compact tail", async () => {
    const sessionId = "sess-compact-exact";
    await writeSession(sessionId);
    const { app } = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir: testDir,
      codexSessionsDir,
    });

    const res = await app.request(
      `/api/projects/${projectId}/sessions/${sessionId}`,
      { headers: { "X-Yep-Anywhere": "true" } },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(
      json.messages.map((message: { uuid?: string }) => message.uuid),
    ).toEqual(["cb1", "u2", "a2", "cb2", "u3"]);
    expect(json.pagination).toMatchObject({
      hasOlderMessages: true,
      returnedMessageCount: 5,
      totalCompactions: 2,
      truncatedBeforeMessageId: "cb1",
    });
  });
});
