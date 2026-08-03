import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The lifecycle host intentionally runs as plain Node ESM.
import { CodexRuntimeHost } from "../../../../../scripts/codex-runtime-host.mjs";

const temporaryPaths: string[] = [];

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function createFakeCodex(runtimeRoot: string): Promise<string> {
  const scriptPath = join(runtimeRoot, "fake-codex.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import { rmSync } from "node:fs";
import { createServer } from "node:net";

const listen = process.argv[process.argv.indexOf("--listen") + 1];
const socketPath = listen.slice("unix://".length);
try { rmSync(socketPath); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const server = createServer(() => {});
server.listen(socketPath);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    { mode: 0o755 },
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CodexRuntimeHost", () => {
  it("keeps a runtime through owner loss, permits reclaim, and reaps it after release", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const fakeCodex = await createFakeCodex(runtimeRoot);
    const cleanupPath = await mkdtemp(join(tmpdir(), "ya-agentctl-session-"));
    temporaryPaths.push(cleanupPath);
    await writeFile(join(cleanupPath, "marker"), "owned by host", "utf8");
    const host = new CodexRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "test-token",
      attachTimeoutMs: 150,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);

    const launched = await host.handleRequest(
      {
        token: "test-token",
        op: "launch",
        generation: "one",
        command: fakeCodex,
        projectPath: runtimeRoot,
        env: process.env,
        cleanupPaths: [cleanupPath],
      },
      owner,
    );
    const bound = host.bind({
      runtimeId: launched.runtimeId,
      sessionId: "thread-1",
    });
    expect(processGroupAlive(bound.processGroupId)).toBe(true);

    host.detachGeneration("one");
    host.registeredServers.delete("one");
    host.registeredServers.set("two", owner);
    const reclaimed = host.claim({
      generation: "two",
      sessionId: "thread-1",
    });
    expect(reclaimed?.runtimeId).toBe(launched.runtimeId);

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(processGroupAlive(bound.processGroupId)).toBe(true);

    host.release({ runtimeId: launched.runtimeId, generation: "two" });
    await waitUntil(() => !processGroupAlive(bound.processGroupId));
    await waitUntil(() => !host.runtimes.has(launched.runtimeId));
    await expect(
      readFile(join(cleanupPath, "marker"), "utf8"),
    ).rejects.toThrow();

    await host.shutdown("test complete");
  });

  it("reaps every runtime during terminal host shutdown", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new CodexRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      attachTimeoutMs: 5_000,
    });
    const fakeCodex = await createFakeCodex(runtimeRoot);
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launched = await host.handleRequest(
      {
        token: "test-token",
        op: "launch",
        generation: "one",
        command: fakeCodex,
        projectPath: runtimeRoot,
        env: process.env,
      },
      owner,
    );

    await host.shutdown("terminal test");

    expect(processGroupAlive(launched.processGroupId)).toBe(false);
    expect(host.runtimes.size).toBe(0);
  });
});
