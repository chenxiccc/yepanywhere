import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

function decodeClientFrame(payload: string | Buffer): unknown {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  if (payload[0] !== 0x01) {
    return null;
  }
  return JSON.parse(payload.subarray(1).toString("utf8"));
}

test.describe("Session streams", () => {
  test("session detail subscribes to focused watch stream over WebSocket", async ({
    page,
    baseURL,
  }) => {
    const sentMessages: unknown[] = [];
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        try {
          sentMessages.push(decodeClientFrame(frame.payload));
        } catch {
          // Ignore non-YA frames; the assertion below filters for subscribe.
        }
      });
    });

    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible({ timeout: 10000 });

    await expect
      .poll(
        () =>
          sentMessages.find(
            (
              message,
            ): message is {
              type: string;
              channel: string;
              sessionId: string;
              projectId?: string;
            } =>
              Boolean(message) &&
              typeof message === "object" &&
              (message as { type?: unknown }).type === "subscribe" &&
              (message as { channel?: unknown }).channel === "session-watch" &&
              (message as { sessionId?: unknown }).sessionId === sessionId,
          ),
        { timeout: 5000 },
      )
      .toMatchObject({
        type: "subscribe",
        channel: "session-watch",
        sessionId,
        projectId,
      });
  });
});
