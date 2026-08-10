import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "file-viewer-absolute-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.locator(".onboarding-skip-all");
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

async function capture(page: Page, name: string) {
  const artifactDir = process.env.YEP_UI_CAPTURE_DIR;
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDir, `${name}.png`),
  });
}

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`minimizes and restores an external file viewer at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    const glossaryRequests: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/glossary-artifact")) {
        glossaryRequests.push(url);
      }
    });

    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const absoluteLink = page.locator(
      'a[data-ya-private-project-file-link="true"]',
    );
    await expect(absoluteLink).toBeVisible({ timeout: 10000 });
    await dismissOnboardingIfVisible(page);
    await absoluteLink.click();

    const viewer = page.locator(".file-viewer");
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.locator('[data-glossary-term="true"]', {
        hasText: "Viewer context",
      }),
    ).toBeVisible();
    await expect.poll(() => glossaryRequests.length).toBeGreaterThan(0);
    expect(glossaryRequests.at(-1)?.searchParams.has("sourcePath")).toBe(false);

    const controller = page.getByRole("group", { name: /File viewer:/ });
    await expect(controller).toBeVisible();
    await expect(controller).toContainText("README.md");
    await expect(
      controller.getByRole("button", { name: /Minimize file viewer:/ }),
    ).toBeVisible();

    await capture(page, `${viewport.name}-open`);
    await viewer.getByRole("button", { name: "Minimize file viewer" }).click();
    await expect(viewer).not.toBeVisible();

    const restore = controller.getByRole("button", {
      name: /Restore file viewer:/,
    });
    await expect(restore).toBeVisible();
    expect((await controller.boundingBox())?.width).toBeGreaterThanOrEqual(
      viewport.name === "mobile" ? 148 : 60,
    );
    expect(
      await controller.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toContain("file-viewer-arrive");
    await capture(page, `${viewport.name}-parked`);

    await restore.click();
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();

    await controller
      .getByRole("button", { name: /Minimize file viewer:/ })
      .click();
    await expect(viewer).not.toBeVisible();
    await controller
      .getByRole("button", { name: /Close file viewer:/ })
      .click();
    await expect(controller).not.toBeVisible();
  });
}
