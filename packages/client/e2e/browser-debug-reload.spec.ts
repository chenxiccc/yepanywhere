import { mkdirSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.locator(".onboarding-skip-all");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
}

async function captureMenu(page: Page, testInfo: TestInfo, name: string) {
  const captureDir =
    process.env.YEP_BROWSER_DEBUG_CAPTURE_DIR ??
    join(e2ePaths.tempDir, "browser-debug-reload-captures");
  mkdirSync(captureDir, { recursive: true });
  const path = join(captureDir, `${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`keeps browser debugging active across reload at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(45_000);
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-session-toolbar-presence",
        JSON.stringify({ browserDebug: "pin" }),
      );
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const inactiveControl = page.getByRole("button", {
      name: /Enable full JavaScript debugging/,
    });
    await expect(inactiveControl).toBeVisible();
    await inactiveControl.click();

    const activeControl = page.getByRole("button", {
      name: /Disable full JavaScript debugging/,
    });
    await expect(activeControl).toBeVisible();
    const expiryBeforeReload = (
      await activeControl.getAttribute("aria-label")
    )?.split("\n")[0];
    await activeControl.click({ button: "right" });

    await expect(
      page.getByRole("menuitem", {
        name: "Reload app code (keep debugging)",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "Reconnect existing debug link",
      }),
    ).toBeDisabled({ timeout: 25_000 });
    await captureMenu(page, testInfo, `${viewport.name}-debug-menu`);

    await Promise.all([
      page.waitForEvent("load"),
      page
        .getByRole("menuitem", {
          name: "Reload app code (keep debugging)",
        })
        .click(),
    ]);

    const resumedControl = page.getByRole("button", {
      name: /Disable full JavaScript debugging/,
    });
    await expect(resumedControl).toBeVisible();
    expect(
      (await resumedControl.getAttribute("aria-label"))?.split("\n")[0],
    ).toBe(expiryBeforeReload);
    await resumedControl.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", {
        name: "Reconnect existing debug link",
      }),
    ).toBeDisabled({ timeout: 25_000 });
    await page.keyboard.press("Escape");
    await resumedControl.click();
    await expect(inactiveControl).toBeVisible();
  });
}
