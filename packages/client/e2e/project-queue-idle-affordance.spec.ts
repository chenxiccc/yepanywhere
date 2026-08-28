import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  const appeared = await dialog
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function expectIdleProjectQueueAction(page: Page) {
  const action = page.getByRole("button", {
    name: "Queue for Project Queue",
  });
  await expect(action).toBeVisible({ timeout: 10_000 });
  await expect(action).toHaveAttribute("data-project-queue-state", "unblocked");
  await expect(action).toHaveCSS("background-color", "rgb(4, 120, 87)");
}

test("keeps the current-session Project Queue action visible while idle", async ({
  page,
  baseURL,
}) => {
  const captureDir = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (captureDir) mkdirSync(captureDir, { recursive: true });

  await page.addInitScript(() => {
    localStorage.setItem(
      "yep-anywhere-session-toolbar-presence",
      JSON.stringify({ projectQueue: "pin" }),
    );
  });

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await page
    .locator("[data-composer-input]")
    .fill("Queue this after the project is idle");
  await expectIdleProjectQueueAction(page);
  if (captureDir) {
    await page.screenshot({
      animations: "disabled",
      path: join(captureDir, "desktop-1000x600.png"),
    });
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await expectIdleProjectQueueAction(page);
  if (captureDir) {
    await page.screenshot({
      animations: "disabled",
      path: join(captureDir, "phone-375x812.png"),
    });
  }
});
