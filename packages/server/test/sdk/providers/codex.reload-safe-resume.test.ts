import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The lifecycle host intentionally runs as plain Node ESM.
import { CodexRuntimeHost } from "../../../../../scripts/codex-runtime-host.mjs";
import { CodexProvider } from "../../../src/sdk/providers/codex.js";
import {
  closeCodexRuntimeHostRegistration,
  initializeCodexRuntimeHost,
} from "../../../src/sdk/providers/codex-runtime-host.js";

const temporaryPaths: string[] = [];

interface FakeSocketCodexScenario {
  resumedTurns?: unknown[];
  notificationsAfterResume?: Array<{
    method: string;
    params: unknown;
  }>;
}

async function createFakeSocketCodex(
  runtimeRoot: string,
  logPath: string,
  scenario: FakeSocketCodexScenario = {},
): Promise<string> {
  const require = createRequire(import.meta.url);
  const wsModuleUrl = pathToFileURL(require.resolve("ws")).href;
  const scriptPath = join(runtimeRoot, "fake-socket-codex.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import wsPackage from ${JSON.stringify(wsModuleUrl)};

const { WebSocketServer } = wsPackage;

const logPath = ${JSON.stringify(logPath)};
const resumedTurns = ${JSON.stringify(scenario.resumedTurns ?? [])};
const notificationsAfterResume = ${JSON.stringify(
      scenario.notificationsAfterResume ?? [],
    )};
const listen = process.argv[process.argv.indexOf("--listen") + 1];
const socketPath = listen.slice("unix://".length);
try { rmSync(socketPath); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const server = createServer();
const sockets = new Set();
const webSockets = new WebSocketServer({ server, perMessageDeflate: false });

function respond(socket, id, result) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

webSockets.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    appendFileSync(logPath, JSON.stringify(message) + "\\n");
    if (message.id === undefined) return;
    switch (message.method) {
      case "initialize":
        respond(socket, message.id, { userAgent: "fake-codex" });
        break;
      case "skills/list":
        respond(socket, message.id, {
          data: [{ cwd: message.params?.cwds?.[0] ?? "", skills: [], errors: [] }],
        });
        break;
      case "thread/resume":
        respond(socket, message.id, {
          thread: { id: message.params.threadId, turns: resumedTurns },
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
        });
        for (const notification of notificationsAfterResume) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", ...notification }));
        }
        break;
      default:
        respond(socket, message.id, {});
        break;
    }
  });
});

server.listen(socketPath);
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.terminate();
  webSockets.close();
  server.close(() => process.exit(0));
});
`,
    { mode: 0o755 },
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  closeCodexRuntimeHostRegistration();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

describeOnLinux("CodexProvider reload-safe resume", () => {
  it("restores only unfinished state from a large active snapshot", async () => {
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "codex-resume-host-test-"),
    );
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const logPath = join(runtimeRoot, "requests.jsonl");
    const completedMessages = Array.from({ length: 240 }, (_, index) => ({
      id: `completed-message-${index}`,
      type: "agentMessage",
      text: `Completed snapshot message ${index}`,
    }));
    const completedCompactions = Array.from({ length: 8 }, (_, index) => ({
      id: `completed-compaction-${index}`,
      type: "contextCompaction",
    }));
    const fakeCodex = await createFakeSocketCodex(runtimeRoot, logPath, {
      resumedTurns: [
        {
          id: "stale-active-turn",
          items: [
            {
              id: "stale-completed-message",
              type: "agentMessage",
              text: "Old stale turn output",
            },
          ],
          status: "inProgress",
          error: null,
        },
        {
          id: "current-active-turn",
          items: [
            ...completedMessages,
            ...completedCompactions,
            {
              id: "completed-command",
              type: "commandExecution",
              command: "printf complete",
              aggregatedOutput: "complete",
              exitCode: 0,
              status: "completed",
            },
            {
              id: "running-command",
              type: "commandExecution",
              command: "sleep 5",
              aggregatedOutput: "",
              status: "inProgress",
            },
          ],
          status: "inProgress",
          error: null,
        },
      ],
      notificationsAfterResume: [
        {
          method: "item/completed",
          params: {
            threadId: "existing-thread",
            turnId: "current-active-turn",
            item: {
              id: "running-command",
              type: "commandExecution",
              command: "sleep 5",
              aggregatedOutput: "done",
              exitCode: 0,
              status: "completed",
            },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "existing-thread",
            turn: {
              id: "current-active-turn",
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        },
      ],
    });
    const host = new CodexRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "resume-test-token",
      attachTimeoutMs: 5_000,
    });
    await host.start();
    const previousGeneration = process.env.YEP_SERVER_GENERATION;
    let session: Awaited<ReturnType<CodexProvider["startSession"]>> | undefined;

    try {
      process.env.YEP_CODEX_RUNTIME_SOCKET = controlSocketPath;
      process.env.YEP_CODEX_RUNTIME_TOKEN = "resume-test-token";
      process.env.YEP_SERVER_GENERATION = "resume-test-generation";
      expect(await initializeCodexRuntimeHost()).toBe(true);

      const provider = new CodexProvider({ codexPath: fakeCodex });
      provider.setReloadSafeSessionsGetter(() => true);
      session = await provider.startSession({
        cwd: runtimeRoot,
        resumeSessionId: "existing-thread",
        initialMessage: { text: "continue" },
      });
      let viewerPublicationSettled = false;
      const viewerPublication = Promise.resolve(
        session.setRuntimeViewerPresence?.(false),
      ).then(() => {
        viewerPublicationSettled = true;
      });
      await Promise.resolve();
      expect(viewerPublicationSettled).toBe(false);

      const init = await session.iterator.next();
      await viewerPublication;
      expect(init.value).toMatchObject({
        type: "system",
        subtype: "init",
        session_id: "existing-thread",
      });
      const resumedMessages: Array<Record<string, unknown>> = [];
      for (let index = 0; index < 12; index += 1) {
        const next = await session.iterator.next();
        if (next.done) break;
        const message = next.value as unknown as Record<string, unknown>;
        resumedMessages.push(message);
        if (message.type === "result") break;
      }
      expect(resumedMessages.at(-1)).toMatchObject({ type: "result" });
      expect(
        resumedMessages.filter((message) => message.uuid === "running-command"),
      ).toHaveLength(2);
      expect(resumedMessages).toContainEqual(
        expect.objectContaining({
          type: "user",
          uuid: "running-command-result",
        }),
      );
      expect(resumedMessages).not.toContainEqual(
        expect.objectContaining({ uuid: "completed-command" }),
      );
      expect(resumedMessages).not.toContainEqual(
        expect.objectContaining({
          uuid: "completed-message-0-current-active-turn",
        }),
      );
      expect(resumedMessages).not.toContainEqual(
        expect.objectContaining({ subtype: "compact_boundary" }),
      );
      expect([...host.runtimes.values()]).toEqual([
        expect.objectContaining({
          sessionId: "existing-thread",
          attachedServerGeneration: "resume-test-generation",
          unviewedSince: expect.any(String),
        }),
      ]);
      const requests = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { method?: string; params?: unknown },
        );
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "thread/resume",
          params: expect.objectContaining({ threadId: "existing-thread" }),
        }),
      );
    } finally {
      await session?.abort();
      await session?.iterator.return?.();
      await host.shutdown("test complete");
      if (previousGeneration === undefined) {
        delete process.env.YEP_SERVER_GENERATION;
      } else {
        process.env.YEP_SERVER_GENERATION = previousGeneration;
      }
    }
  });
});
