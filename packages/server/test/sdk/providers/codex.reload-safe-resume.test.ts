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

async function createFakeSocketCodex(
  runtimeRoot: string,
  logPath: string,
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
          thread: { id: message.params.threadId, turns: [] },
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
        });
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

describe("CodexProvider reload-safe resume", () => {
  it("launches an enabled resumed session through the lifecycle host", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-resume-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const logPath = join(runtimeRoot, "requests.jsonl");
    const fakeCodex = await createFakeSocketCodex(runtimeRoot, logPath);
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
      const init = await session.iterator.next();
      expect(init.value).toMatchObject({
        type: "system",
        subtype: "init",
        session_id: "existing-thread",
      });
      expect([...host.runtimes.values()]).toEqual([
        expect.objectContaining({
          sessionId: "existing-thread",
          attachedServerGeneration: "resume-test-generation",
        }),
      ]);
      const requests = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
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
