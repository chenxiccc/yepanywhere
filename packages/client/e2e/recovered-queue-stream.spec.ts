import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  startYaServerProcess,
  stopYaServerProcess,
  type YaServerProcess,
} from "./support/ya-server-process.js";

const sessionId = "recovered-queue-session";
const queueId = "recovered-publish-queue-item";
const queuedAt = "2026-08-06T07:33:44.792Z";
let projectPath = "";
let projectId = "";
let server: YaServerProcess | null = null;

function decodeServerFrame(payload: string | Buffer): unknown {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  if (payload[0] !== 0x01) {
    return null;
  }
  return JSON.parse(payload.subarray(1).toString("utf8"));
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, name),
    animations: "disabled",
  });
}

test.use({ serviceWorkers: "block", viewport: { width: 1920, height: 1080 } });

test.describe("Recovered queue stream snapshots", () => {
  test.beforeAll(async () => {
    projectPath = mkdtempSync(join(tmpdir(), "ya-recovered-queue-project-"));
    projectId = Buffer.from(projectPath).toString("base64url");
    server = await startYaServerProcess({
      label: "recovered queue server",
      tempPrefix: "ya-recovered-queue-server-",
      mockClaudeSession: {
        projectPath,
        sessionId,
        content: "Previous queued session context",
      },
      setupProfile: ({ dataDir }) => {
        writeFileSync(
          join(dataDir, "session-queued-messages.json"),
          JSON.stringify({
            version: 1,
            items: [
              {
                id: queueId,
                sessionId,
                projectId,
                projectPath,
                provider: "claude",
                mode: "default",
                kind: "patient",
                message: {
                  text: "publish",
                  mode: "default",
                  tempId: "temp-recovered-publish",
                  metadata: {
                    deliveryIntent: "patient",
                    patienceSeconds: 2,
                    serverReceivedAt: queuedAt,
                  },
                },
                createdAt: queuedAt,
                updatedAt: queuedAt,
                queuedAt,
                status: "paused-after-restart",
                source: { tempId: "temp-recovered-publish" },
              },
            ],
          }),
        );
      },
      env: {
        USE_MOCK_SDK: "true",
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: join(process.cwd(), "dist"),
      },
    });

    const response = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/sessions/${sessionId}/reactivate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to reactivate recovered queue session: ${response.status} ${await response.text()}`,
      );
    }
  });

  test.afterAll(() => {
    stopYaServerProcess(server);
    if (projectPath) {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test("keeps a restart-paused chip after the live connected snapshot", async ({
    page,
  }) => {
    let connected = false;
    page.on("websocket", (webSocket) => {
      webSocket.on("framereceived", (frame) => {
        try {
          const message = decodeServerFrame(frame.payload) as {
            type?: string;
            eventType?: string;
            data?: { sessionId?: string };
          } | null;
          if (
            message?.type === "event" &&
            message.eventType === "connected" &&
            message.data?.sessionId === sessionId
          ) {
            connected = true;
          }
        } catch {
          // Ignore protocol frames that are not JSON event envelopes.
        }
      });
    });

    if (!server) throw new Error("Recovered queue server did not start");
    await page.goto(
      `${server.baseUrl}/projects/${projectId}/sessions/${sessionId}`,
    );
    await dismissOnboardingIfVisible(page);

    await expect(
      page.getByRole("main").getByText("Previous queued session context"),
    ).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => connected, { timeout: 10_000 }).toBe(true);

    const recoveredChip = page
      .locator(".deferred-message")
      .filter({ hasText: "publish" });
    await expect(recoveredChip).toHaveCount(1);
    await expect(recoveredChip.getByText("Paused after restart")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(recoveredChip).toHaveCount(1);
    await capture(page, "recovered-queue-desktop.png");

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(recoveredChip).toHaveCount(1);
    await expect(recoveredChip.getByText("Paused after restart")).toBeVisible();
    await capture(page, "recovered-queue-mobile.png");
  });
});
