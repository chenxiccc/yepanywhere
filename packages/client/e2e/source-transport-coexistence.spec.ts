import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  startYaServerProcess,
  stopYaServerProcess,
  type YaServerProcess,
} from "./support/ya-server-process.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

interface SmokeResult {
  versions: Record<"local" | "secondary", string>;
  sessionMessageText: Record<"local" | "secondary", string[]>;
  sessionFailures: Record<
    "local" | "secondary",
    { status: number | null; message: string }
  >;
  pingCounts: Record<"local" | "secondary", number>;
  visibilityRestored: Record<"local" | "secondary", number>;
  statusWithStreams: Record<
    "local" | "secondary",
    { state: string; channels: Array<{ name: string; state: string }> }
  >;
  statusAfterSecondaryDispose: {
    local: { state: string };
    secondary: { state: string };
  };
  localVersionAfterSecondaryDispose: string;
}

interface SmokeWindow {
  __YA_SOURCE_TRANSPORT_COEXISTENCE_SMOKE__?: (input: {
    secondaryWsUrl: string;
    projectId: string;
    sessionId: string;
  }) => Promise<SmokeResult>;
}

test.describe("Source transport coexistence", () => {
  let secondaryServer: YaServerProcess | null = null;

  test.beforeAll(async () => {
    secondaryServer = await startYaServerProcess({
      label: "T10 secondary server",
      tempPrefix: "ya-source-t10-",
      mockClaudeSession: {
        projectPath: mockProjectPath,
        sessionId,
        content: "Second profile previous message",
      },
    });
  });

  test.afterAll(() => {
    stopYaServerProcess(secondaryServer);
  });

  test("keeps localhost and second direct WebSocket sources independent", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${baseURL}/projects`);
    await page.waitForLoadState("domcontentloaded");

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              typeof (window as SmokeWindow)
                .__YA_SOURCE_TRANSPORT_COEXISTENCE_SMOKE__,
          ),
        { timeout: 10_000 },
      )
      .toBe("function");

    if (!secondaryServer) {
      throw new Error("Secondary server did not start");
    }

    const result = await page.evaluate(
      async ({ port, projectId, sessionId }) => {
        const run = (window as SmokeWindow)
          .__YA_SOURCE_TRANSPORT_COEXISTENCE_SMOKE__;
        if (!run) throw new Error("Source transport smoke helper unavailable");
        return run({
          secondaryWsUrl: `ws://127.0.0.1:${port}/api/ws`,
          projectId,
          sessionId,
        });
      },
      { port: secondaryServer.port, projectId, sessionId },
    );

    expect(result.versions.local).toBeTruthy();
    expect(result.versions.secondary).toBeTruthy();
    expect(result.localVersionAfterSecondaryDispose).toBe(
      result.versions.local,
    );

    expect(result.sessionMessageText.local).toContain("Previous message");
    expect(result.sessionMessageText.secondary).toContain(
      "Second profile previous message",
    );

    expect(result.statusWithStreams.local.state).toBe("ready");
    expect(result.statusWithStreams.secondary.state).toBe("ready");
    expect(
      result.statusWithStreams.local.channels.some(
        (channel) =>
          channel.name === "stream-websocket" && channel.state === "connected",
      ),
    ).toBe(true);
    expect(
      result.statusWithStreams.secondary.channels.some(
        (channel) =>
          channel.name === "multiplex-websocket" &&
          channel.state === "connected",
      ),
    ).toBe(true);

    expect(result.pingCounts.local).toBeGreaterThanOrEqual(2);
    expect(result.pingCounts.secondary).toBe(1);
    expect(result.visibilityRestored.local).toBeGreaterThanOrEqual(2);
    expect(result.visibilityRestored.secondary).toBe(1);

    expect(result.statusAfterSecondaryDispose.local.state).toBe("ready");
    expect(result.statusAfterSecondaryDispose.secondary.state).toBe(
      "disconnected",
    );
    expect(result.sessionFailures.local.status).toBe(404);
    expect(result.sessionFailures.secondary.status).toBe(404);
  });
});
