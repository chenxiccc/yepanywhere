import type { Page, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  startMultiHostRelayHarness,
  type MultiHostRelayHarness,
} from "./support/multi-host-relay-harness.js";

interface ProvisionInput {
  displayName: string;
  password: string;
  relayUrl: string;
  username: string;
}

interface MonitorResult {
  connectedCount: number;
  hosts: Array<{
    displayName: string;
    state: string;
    summary?: {
      sessions: Array<{ id: string; title: string }>;
    };
  }>;
  selectedCount: number;
}

async function provisionHosts(
  page: Page,
  inputs: ProvisionInput[],
): Promise<void> {
  await page.evaluate(async (provisionInputs) => {
    localStorage.clear();
    sessionStorage.clear();
    const modulePath = "/src/lib/e2e/multiHostSessionProvisioning.ts";
    const { provisionRelayHostSession } = await import(
      /* @vite-ignore */ modulePath
    );
    await Promise.all(provisionInputs.map(provisionRelayHostSession));
  }, inputs);
}

async function runMonitorController(page: Page): Promise<MonitorResult> {
  return page.evaluate(async () => {
    const monitorModulePath = "/src/lib/multiHostMonitor.ts";
    const storageModulePath = "/src/lib/hostStorage.ts";
    const [{ MultiHostMonitorController }, { loadSavedHosts }] =
      await Promise.all([
        import(/* @vite-ignore */ monitorModulePath),
        import(/* @vite-ignore */ storageModulePath),
      ]);
    const controller = new MultiHostMonitorController(loadSavedHosts().hosts);
    controller.start();

    try {
      const snapshot = await new Promise<MonitorResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Multi-host controller did not reach 3/3 ready"));
        }, 30_000);
        const check = () => {
          const current = controller.getSnapshot() as MonitorResult;
          if (
            current.connectedCount === 3 ||
            current.hosts.some(
              (host) =>
                host.state === "offline" || host.state === "sign-in-required",
            )
          ) {
            clearTimeout(timeout);
            unsubscribe();
            resolve(current);
          }
        };
        const unsubscribe = controller.subscribe(check);
        check();
      });
      return snapshot;
    } finally {
      controller.dispose();
    }
  });
}

test.describe("Secure multi-host coexistence", () => {
  test.describe.configure({ mode: "serial", timeout: 60_000 });
  let harness: MultiHostRelayHarness | null = null;

  test.beforeAll(async ({ relayWsURL }) => {
    harness = await startMultiHostRelayHarness({
      relayUrl: relayWsURL,
      testRoot: e2ePaths.tempDir,
    });
  });

  test.afterAll(() => {
    harness?.stop();
  });

  test("keeps three relay-backed source runtimes independent", async ({
    page,
    remoteClientURL,
  }, testInfo) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await page.goto(remoteClientURL);
    await provisionHosts(
      page,
      harness.hosts.map((host) => ({
        displayName: host.displayName,
        password: host.password,
        relayUrl: harness?.relayUrl ?? "",
        username: host.username,
      })),
    );
    await harness.waitForWaitingHosts();

    const relaySockets: PlaywrightWebSocket[] = [];
    page.on("websocket", (socket) => {
      if (socket.url() === harness?.relayUrl) {
        relaySockets.push(socket);
      }
    });

    const result = await runMonitorController(page);
    if (result.connectedCount !== 3) {
      await testInfo.attach("multi-host-server-output", {
        body: harness.formatOutput(),
        contentType: "text/plain",
      });
    }

    expect(result).toMatchObject({
      connectedCount: 3,
      selectedCount: 3,
    });
    expect(relaySockets).toHaveLength(3);
    expect(result.hosts.map((host) => host.state)).toEqual([
      "connected",
      "connected",
      "connected",
    ]);
    expect(result.hosts.map((host) => host.summary?.sessions[0]?.id)).toEqual([
      harness.sessionId,
      harness.sessionId,
      harness.sessionId,
    ]);
    expect(
      result.hosts.map((host) => host.summary?.sessions[0]?.title),
    ).toEqual(harness.hosts.map((host) => host.expectedFixtureText));
  });
});
