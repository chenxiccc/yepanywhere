import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

const viewports = [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const;

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.locator(".onboarding-skip-all");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function bottomGap(page: Page) {
  return page.locator(".message-list").evaluate((list) => {
    const viewport = list.parentElement;
    if (!viewport) throw new Error("Message list has no scroll viewport");
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  });
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

for (const viewport of viewports) {
  test(`keeps one Follow activation sticky on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible({ timeout: 10_000 });

    await page.locator(".message-list").evaluate((list) => {
      const spacer = document.createElement("div");
      spacer.dataset.followRaceSpacer = "true";
      spacer.textContent = "Simulated live output after Follow";
      Object.assign(spacer.style, {
        alignItems: "flex-end",
        display: "flex",
        minHeight: "1200px",
        padding: "16px",
      });
      list.append(spacer);
    });
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      if (!scrollViewport)
        throw new Error("Message list has no scroll viewport");
      scrollViewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
      );
      scrollViewport.scrollTop = Math.max(
        0,
        scrollViewport.scrollHeight - scrollViewport.clientHeight - 400,
      );
      scrollViewport.dispatchEvent(new Event("scroll"));
    });

    const follow = page.getByRole("button", {
      name: "Follow latest session output",
    });
    await expect(follow).toBeVisible();
    await follow.click();
    await expect(follow).not.toBeVisible();

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      const spacer = list.querySelector<HTMLElement>(
        "[data-follow-race-spacer]",
      );
      if (!scrollViewport || !spacer) {
        throw new Error("Follow race fixture is incomplete");
      }
      spacer.style.minHeight = "1800px";
      scrollViewport.dispatchEvent(new Event("scroll"));
    });

    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);
    await expect(follow).not.toBeVisible();
    await expect(
      page.getByText("Simulated live output after Follow"),
    ).toBeVisible();

    await capture(
      page,
      `follow-sticky-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });
}
