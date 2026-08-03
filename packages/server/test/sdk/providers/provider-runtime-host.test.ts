import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The wrapper lifecycle host intentionally runs as plain ESM.
import { ProviderRuntimeHost } from "../../../../../scripts/provider-runtime-host.mjs";
import {
  closeProviderRuntimeHostRegistration,
  initializeProviderRuntimeHost,
  startHostedProviderSession,
} from "../../../src/sdk/providers/provider-runtime-host.js";

const temporaryPaths: string[] = [];
const fixtureWorker = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-provider-runtime-worker.mjs",
);

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

afterEach(async () => {
  closeProviderRuntimeHostRegistration();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "linux")("ProviderRuntimeHost", () => {
  it("retains a worker for replacement and reaps it after attach timeout", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      attachTimeoutMs: 150,
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);

    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 1,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        options: { cwd: runtimeRoot },
      },
      owner,
    );
    host.bind({ runtimeId: launched.runtimeId, sessionId: "session-1" });
    host.confirmAttach({ runtimeId: launched.runtimeId, generation: "one" });
    expect(processGroupAlive(launched.processGroupId)).toBe(true);

    host.detachGeneration("one");
    host.registeredServers.delete("one");
    host.registeredServers.set("two", owner);
    const reclaimed = host.claim({
      generation: "two",
      sessionId: "session-1",
    });
    expect(reclaimed?.runtimeId).toBe(launched.runtimeId);
    host.confirmAttach({ runtimeId: launched.runtimeId, generation: "two" });

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(processGroupAlive(launched.processGroupId)).toBe(true);

    host.release({ runtimeId: launched.runtimeId, generation: "two" });
    await waitUntil(() => !processGroupAlive(launched.processGroupId));
    await waitUntil(() => !host.runtimes.has(launched.runtimeId));
    expect(host.runtimes.size).toBe(0);
    await host.shutdown("test complete");
  });

  it("reaps all workers on terminal host shutdown", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 1,
        op: "launch",
        generation: "one",
        providerName: "pi",
        projectPath: runtimeRoot,
        options: { cwd: runtimeRoot },
      },
      owner,
    );

    await host.shutdown("terminal test");

    expect(processGroupAlive(launched.processGroupId)).toBe(false);
    expect(host.runtimes.size).toBe(0);
  });

  it("reaps a claimed runtime when its controller never attaches", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      attachTimeoutMs: 100,
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const launched = await host.handleRequest(
      {
        token: "test-token",
        protocolVersion: 1,
        op: "launch",
        generation: "one",
        providerName: "claude",
        projectPath: runtimeRoot,
        sessionId: "unattached-session",
        options: { cwd: runtimeRoot },
      },
      owner,
    );

    await waitUntil(() => !processGroupAlive(launched.processGroupId));
    await waitUntil(() => !host.runtimes.has(launched.runtimeId));
    await host.shutdown("unattached test complete");
  });

  it("reaps wrapper-lifetime provider resources on terminal shutdown", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const owner = { destroy() {} };
    host.registeredServers.set("one", owner);
    const resource = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!resource.pid) throw new Error("resource process did not start");

    try {
      await host.handleRequest(
        {
          token: "test-token",
          protocolVersion: 1,
          op: "retainProcessGroup",
          generation: "one",
          processGroupId: resource.pid,
        },
        owner,
      );
      expect(processGroupAlive(resource.pid)).toBe(true);

      await host.shutdown("terminal resource test");

      expect(processGroupAlive(resource.pid)).toBe(false);
    } finally {
      if (processGroupAlive(resource.pid)) {
        process.kill(-resource.pid, "SIGKILL");
      }
    }
  });

  it("does not signal a process group whose Linux identity changed", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-host-test-"));
    temporaryPaths.push(runtimeRoot);
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath: join(runtimeRoot, "host.sock"),
      token: "test-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    const resource = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!resource.pid) throw new Error("resource process did not start");
    host.retainedProcessGroups.set(resource.pid, {
      processGroupId: resource.pid,
      leaderStartTime: "not-the-current-process",
    });

    try {
      await host.shutdown("stale identity test");
      expect(processGroupAlive(resource.pid)).toBe(true);
    } finally {
      if (processGroupAlive(resource.pid)) {
        process.kill(-resource.pid, "SIGKILL");
      }
    }
  });

  it("holds replayed callbacks until Process installs its handlers", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "callback-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "callback-token";
    process.env.YEP_SERVER_GENERATION = "callbacks";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    let approvalCount = 0;
    const session = await startHostedProviderSession(
      "claude",
      {
        cwd: runtimeRoot,
        onToolApproval: async () => {
          approvalCount += 1;
          return { behavior: "allow" };
        },
      },
      {},
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approvalCount).toBe(0);
    session.activateCallbacks?.();
    await waitUntil(() => approvalCount === 1);

    await session.abort();
    await host.shutdown("callback test complete");
  });

  it("propagates provider approval cancellation to the active callback", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "approval-cancel-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "approval-cancel-token";
    process.env.YEP_SERVER_GENERATION = "approval-cancel";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    let callbackStarted = false;
    let callbackAborted = false;
    const session = await startHostedProviderSession(
      "pi",
      {
        cwd: runtimeRoot,
        onToolApproval: async (_toolName, _input, options) => {
          callbackStarted = true;
          return await new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => {
                callbackAborted = true;
                resolve({ behavior: "deny", message: "cancelled" });
              },
              { once: true },
            );
          });
        },
      },
      {},
    );
    session.activateCallbacks?.();

    await waitUntil(() => callbackStarted && callbackAborted);

    await session.abort();
    await host.shutdown("approval cancellation test complete");
  });

  it("reattaches the AgentSession proxy to the same worker", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "provider-proxy-test-"));
    temporaryPaths.push(runtimeRoot);
    const controlSocketPath = join(runtimeRoot, "host.sock");
    const host = new ProviderRuntimeHost({
      runtimeDir: runtimeRoot,
      controlSocketPath,
      token: "proxy-token",
      workerPath: fixtureWorker,
    });
    await host.start();
    process.env.YEP_PROVIDER_RUNTIME_SOCKET = controlSocketPath;
    process.env.YEP_PROVIDER_RUNTIME_TOKEN = "proxy-token";
    process.env.YEP_SERVER_GENERATION = "one";
    expect(await initializeProviderRuntimeHost()).toBe(true);

    const first = await startHostedProviderSession(
      "claude",
      { cwd: runtimeRoot },
      {},
    );
    const firstEvent = await first.iterator.next();
    expect(firstEvent.value?.session_id).toBe("fake-session-1");
    const waitingForMore = first.iterator.next();
    await first.publishAgentctlSessionId?.("canonical-session");
    await first.detachForServerReload?.();
    await expect(waitingForMore).resolves.toEqual({
      done: true,
      value: undefined,
    });

    closeProviderRuntimeHostRegistration();
    process.env.YEP_SERVER_GENERATION = "two";
    expect(await initializeProviderRuntimeHost()).toBe(true);
    const second = await startHostedProviderSession(
      "claude",
      { cwd: runtimeRoot, resumeSessionId: "canonical-session" },
      {},
    );
    const secondEvent = await second.iterator.next();
    expect(secondEvent.value?.session_id).toBe("fake-session-2");
    expect(host.runtimes.size).toBe(1);

    await second.abort();
    await waitUntil(() => host.runtimes.size === 0);
    await host.shutdown("proxy test complete");
  });
});
