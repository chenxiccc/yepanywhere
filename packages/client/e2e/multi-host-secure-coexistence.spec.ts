import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  startMultiHostRelayHarness,
  type MultiHostRelayHarness,
} from "./support/multi-host-relay-harness.js";
import { stopYaServerProcess } from "./support/ya-server-process.js";

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

interface SourceDisposalResult {
  connectedCount: number;
  selectedCount: number;
  titles: string[];
}

type MonitorTransportMode = "legacy" | "mux";

function relaySiblingUrl(relayUrl: string, leaf: "health" | "mux"): string {
  const url = new URL(relayUrl);
  url.protocol = leaf === "health"
    ? url.protocol === "wss:"
      ? "https:"
      : "http:"
    : url.protocol;
  url.pathname = url.pathname.replace(/\/ws$/, `/${leaf}`);
  return url.toString();
}

async function configureMonitorTransport(
  page: Page,
  relayUrl: string,
  mode: MonitorTransportMode,
): Promise<void> {
  if (mode === "mux") return;
  await page.route(relaySiblingUrl(relayUrl, "health"), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        status: "ok",
        uptime: 1,
        waiting: 3,
        pairs: 0,
      }),
    });
  });
}

function observeMonitorRelaySockets(
  page: Page,
  relayUrl: string,
): PlaywrightWebSocket[] {
  const sockets: PlaywrightWebSocket[] = [];
  const muxUrl = relaySiblingUrl(relayUrl, "mux");
  page.on("websocket", (socket) => {
    if (socket.url() === relayUrl || socket.url() === muxUrl) {
      sockets.push(socket);
    }
  });
  return sockets;
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
    // Saved-host order is part of the monitor contract. Authenticate
    // sequentially so handshake completion timing cannot reorder localStorage.
    for (const input of provisionInputs) {
      await provisionRelayHostSession(input);
    }
  }, inputs);
}

async function provisionHarnessHosts(
  page: Page,
  remoteClientURL: string,
  harness: MultiHostRelayHarness,
): Promise<void> {
  await page.goto(remoteClientURL);
  await provisionHosts(
    page,
    harness.hosts.map((host) => ({
      displayName: host.displayName,
      password: host.password,
      relayUrl: harness.relayUrl,
      username: host.username,
    })),
  );
  await harness.waitForWaitingHosts();
}

async function enrollRelayHostThroughUi(
  page: Page,
  host: MultiHostRelayHarness["hosts"][number],
  relayUrl: string,
): Promise<void> {
  await page.getByTestId("relay-mode-button").click();
  await expect(page.getByTestId("relay-login-form")).toBeVisible();
  await page.getByTestId("relay-username-input").fill(host.username);
  await page.getByTestId("srp-password-input").fill(host.password);
  await page.locator(".login-advanced-toggle").click();
  await page.getByTestId("custom-relay-url-input").fill(relayUrl);
  await page.getByTestId("login-button").click();
  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15_000 });
}

async function makeLastHostOffline(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storageModulePath = "/src/lib/hostStorage.ts";
    const { loadSavedHosts, saveHost } = await import(
      /* @vite-ignore */ storageModulePath
    );
    const hosts = loadSavedHosts().hosts;
    const host = hosts.at(-1);
    if (!host) throw new Error("No saved host to make offline");
    saveHost({
      ...host,
      relayUsername: `${host.relayUsername ?? "host"}-offline`,
    });
  });
}

async function makeLastHostSessionStale(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const storageModulePath = "/src/lib/hostStorage.ts";
    const { loadSavedHosts, saveHost } = await import(
      /* @vite-ignore */ storageModulePath
    );
    const hosts = loadSavedHosts().hosts;
    const host = hosts.at(-1);
    if (!host?.session) throw new Error("No saved host session to invalidate");
    saveHost({
      ...host,
      session: {
        ...host.session,
        sessionId: `${host.session.sessionId}-stale`,
      },
    });
  });
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

async function runSingleSourceDisposal(
  page: Page,
): Promise<SourceDisposalResult> {
  return page.evaluate(async () => {
    const monitorModulePath = "/src/lib/multiHostMonitor.ts";
    const runtimeModulePath = "/src/lib/sourceRuntime.ts";
    const sourceIdentityModulePath = "/src/lib/sourceIdentity.ts";
    const storageModulePath = "/src/lib/hostStorage.ts";
    const [
      { MultiHostMonitorController },
      { getSourceRuntimeRegistry },
      { resolveSourceKeyForSavedHost },
      { loadSavedHosts },
    ] = await Promise.all([
      import(/* @vite-ignore */ monitorModulePath),
      import(/* @vite-ignore */ runtimeModulePath),
      import(/* @vite-ignore */ sourceIdentityModulePath),
      import(/* @vite-ignore */ storageModulePath),
    ]);
    const hosts = loadSavedHosts().hosts;
    const controller = new MultiHostMonitorController(hosts);
    controller.start();

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Multi-host controller did not reach 3/3 ready"));
        }, 30_000);
        const check = () => {
          if (controller.getSnapshot().connectedCount === 3) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = controller.subscribe(check);
        check();
      });

      const registry = getSourceRuntimeRegistry();
      const remainingRuntimes = hosts
        .slice(1)
        .map((host) =>
          registry.getOrCreateSourceRuntime(resolveSourceKeyForSavedHost(host)),
        );
      const removedHost = hosts[0];
      if (!removedHost) throw new Error("No source available to dispose");
      controller.deactivateHost(removedHost.id);

      const responses = await Promise.all(
        remainingRuntimes.map((runtime) =>
          runtime.transport.fetch<{
            sessions: Array<{
              customTitle?: string;
              fullTitle?: string;
              id: string;
              lastAgentText?: string;
              title?: string;
            }>;
          }>("/sessions?limit=1"),
        ),
      );
      const snapshot = controller.getSnapshot();
      return {
        connectedCount: snapshot.connectedCount,
        selectedCount: snapshot.selectedCount,
        titles: responses.map((response) => {
          const session = response.sessions[0];
          if (!session) return "";
          return (
            session.customTitle ??
            session.title ??
            session.fullTitle ??
            session.lastAgentText ??
            session.id
          );
        }),
      };
    } finally {
      controller.dispose();
    }
  });
}

for (const transportMode of ["legacy", "mux"] as const) {
test.describe(`Secure multi-host coexistence (${transportMode})`, () => {
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
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);
    if (transportMode === "mux") {
      const capabilities = await page.evaluate(async (healthUrl) => {
        const response = await fetch(healthUrl);
        const body = (await response.json()) as {
          relayCapabilities?: string[];
        };
        return body.relayCapabilities ?? [];
      }, relaySiblingUrl(harness.relayUrl, "health"));
      expect(capabilities).toContain("client-mux-v1");
    }

    const relaySockets = observeMonitorRelaySockets(page, harness.relayUrl);

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
    expect(relaySockets.map((socket) => socket.url())).toEqual(
      transportMode === "mux"
        ? [relaySiblingUrl(harness.relayUrl, "mux")]
        : Array.from({ length: 3 }, () => harness.relayUrl),
    );
    expect(relaySockets).toHaveLength(transportMode === "mux" ? 1 : 3);
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

  test("enrolls three saved hosts through the visible login flow", async ({
    page,
    remoteClientURL,
  }) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await page.goto(remoteClientURL);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();

    for (const host of harness.hosts) {
      await enrollRelayHostThroughUi(page, host, harness.relayUrl);
      await page.locator(".sidebar-switch-host").click();
      await expect(page.getByTestId("saved-hosts-list")).toBeVisible();
      await harness.waitForWaitingHosts();
    }

    await expect(page.locator(".host-picker-item")).toHaveCount(3);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);
    await page.goto(`${remoteClientURL}/-/monitor`);
    await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
      "Connected 3 of 3",
      { timeout: 30_000 },
    );
    for (const host of harness.hosts) {
      await expect(page.getByTestId("multi-host-monitor")).toContainText(
        host.expectedFixtureText,
      );
    }
  });

  test("renders three hosts and closes every stream on navigation", async ({
    page,
    remoteClientURL,
  }, testInfo) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);

    const relaySockets = observeMonitorRelaySockets(page, harness.relayUrl);

    await page.goto(`${remoteClientURL}/-/monitor`);
    try {
      await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
        "Connected 3 of 3",
        { timeout: 30_000 },
      );
    } catch (error) {
      await testInfo.attach("multi-host-server-output", {
        body: harness.formatOutput(),
        contentType: "text/plain",
      });
      throw error;
    }

    await expect
      .poll(() => relaySockets.length, { timeout: 10_000 })
      .toBe(transportMode === "mux" ? 1 : 3);
    for (const host of harness.hosts) {
      const card = page.locator(
        `.multi-host-card[data-host-name="${host.displayName}"]`,
      );
      await expect(card).toHaveAttribute("data-host-state", "connected");
      await expect(card).toContainText(host.expectedFixtureText);
    }

    const captureDir = process.env.YEP_E2E_UI_CAPTURE_DIR;
    if (captureDir && transportMode === "mux") {
      mkdirSync(captureDir, { recursive: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.screenshot({
        animations: "disabled",
        path: join(captureDir, "multi-host-monitor-desktop.png"),
      });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({
        animations: "disabled",
        path: join(captureDir, "multi-host-monitor-phone.png"),
      });
    }

    const closedSockets = relaySockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.on("close", () => resolve());
        }),
    );
    await page.goto(`${remoteClientURL}/login`);
    await Promise.all(closedSockets);
    await harness.waitForWaitingHosts();
  });

  test("keeps healthy hosts visible when one relay target is offline", async ({
    page,
    remoteClientURL,
  }) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await makeLastHostOffline(page);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);

    await page.goto(`${remoteClientURL}/-/monitor`);
    await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
      "Connected 2 of 3",
      { timeout: 30_000 },
    );

    const offlineCard = page.locator(
      `.multi-host-card[data-host-name="${
        harness.hosts.at(-1)?.displayName ?? ""
      }"]`,
    );
    await expect(offlineCard).toHaveAttribute("data-host-state", "offline");
    await expect(
      offlineCard.getByRole("button", { name: "Retry" }),
    ).toBeVisible();
    for (const host of harness.hosts.slice(0, 2)) {
      const card = page.locator(
        `.multi-host-card[data-host-name="${host.displayName}"]`,
      );
      await expect(card).toHaveAttribute("data-host-state", "connected");
      await expect(card).toContainText(host.expectedFixtureText);
    }
  });

  test("disposes one runtime while the others keep serving requests", async ({
    page,
    remoteClientURL,
  }) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);

    const result = await runSingleSourceDisposal(page);

    expect(result).toEqual({
      connectedCount: 2,
      selectedCount: 2,
      titles: harness.hosts.slice(1).map((host) => host.expectedFixtureText),
    });
  });

  test("isolates a stale resume session as sign-in required", async ({
    page,
    remoteClientURL,
  }) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await makeLastHostSessionStale(page);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);

    await page.goto(`${remoteClientURL}/-/monitor`);
    await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
      "Connected 2 of 3",
      { timeout: 30_000 },
    );

    const staleCard = page.locator(
      `.multi-host-card[data-host-name="${
        harness.hosts.at(-1)?.displayName ?? ""
      }"]`,
    );
    await expect(staleCard).toHaveAttribute(
      "data-host-state",
      "sign-in-required",
    );
    await expect(
      staleCard.getByRole("link", { name: "Sign in" }),
    ).toBeVisible();
    for (const host of harness.hosts.slice(0, 2)) {
      await expect(
        page.locator(`.multi-host-card[data-host-name="${host.displayName}"]`),
      ).toHaveAttribute("data-host-state", "connected");
    }
  });

  test("keeps healthy rows live when a connected server disconnects", async ({
    page,
    remoteClientURL,
  }) => {
    if (!harness) throw new Error("Multi-host harness did not start");
    await provisionHarnessHosts(page, remoteClientURL, harness);
    await configureMonitorTransport(page, harness.relayUrl, transportMode);
    await page.goto(`${remoteClientURL}/-/monitor`);
    await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
      "Connected 3 of 3",
      { timeout: 30_000 },
    );

    const disconnectedHost = harness.hosts.at(-1);
    if (!disconnectedHost) throw new Error("No host available to disconnect");
    stopYaServerProcess(disconnectedHost.server);

    await expect(page.getByTestId("multi-host-connected-count")).toHaveText(
      "Connected 2 of 3",
      { timeout: 30_000 },
    );
    await expect(
      page.locator(
        `.multi-host-card[data-host-name="${disconnectedHost.displayName}"]`,
      ),
    ).toHaveAttribute("data-host-state", /^(connecting|offline)$/);
    for (const host of harness.hosts.slice(0, 2)) {
      const card = page.locator(
        `.multi-host-card[data-host-name="${host.displayName}"]`,
      );
      await expect(card).toHaveAttribute("data-host-state", "connected");
      await expect(card).toContainText(host.expectedFixtureText);
    }
  });
});
}
