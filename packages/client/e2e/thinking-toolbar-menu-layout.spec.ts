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

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

async function expectThinkingMenuInsideViewport(
  page: Page,
  viewportWidth: number,
) {
  const menu = page.getByTestId("thinking-toolbar-menu");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error("Thinking menu has no layout box");
  expect(box.x).toBeGreaterThanOrEqual(11.5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth - 11.5);
}

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`keeps the thinking menu inside the ${viewport.name} viewport`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const trigger = page.getByRole("button", { name: /^Thinking:/ }).first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    await expectThinkingMenuInsideViewport(page, viewport.width);

    await capture(
      page,
      `thinking-toolbar-menu-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );

    if (viewport.name === "desktop") {
      await page.setViewportSize({ width: 375, height: 812 });
      await expectThinkingMenuInsideViewport(page, 375);
    }
  });
}

test("keeps the thinking menu inside the phone viewport from the overflow strip", async ({
  page,
  baseURL,
}) => {
  const viewport = { width: 320, height: 812 };
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.setItem(
      "yep-anywhere-session-toolbar-presence",
      JSON.stringify({
        attachments: "first",
        btw: "first",
        conversationView: "first",
        modeSelector: "first",
        nudge: "first",
        projectQueue: "first",
        projectQueueNewSessionShortcut: "first",
        renderMode: "first",
        sessionStatus: "first",
        shortcutsHelp: "first",
        thinkingToggle: "first",
      }),
    );
  });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);

  const more = page.getByRole("button", { name: "More toolbar controls" });
  await expect(more).toBeVisible({ timeout: 10_000 });
  await more.click();

  const overflowStrip = page.getByRole("menu");
  const trigger = overflowStrip.getByRole("button", { name: /^Thinking:/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expectThinkingMenuInsideViewport(page, viewport.width);

  await capture(page, "thinking-toolbar-menu-mobile-overflow-320x812.png");
});
