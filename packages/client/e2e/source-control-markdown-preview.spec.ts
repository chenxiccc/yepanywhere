import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const projectPath = join(e2ePaths.tempDir, "source-control-qmd-project");
const projectId = Buffer.from(projectPath).toString("base64url");

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all" });
  const appeared = await skip
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await skip.click({ force: true });
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

async function openQuartoPreview(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/git-status?projectId=${projectId}`);
  await dismissOnboardingIfVisible(page);
  await page.getByText("report.qmd", { exact: true }).first().click();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("button", { name: "Diff" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Full context" }).click();
  await expect(
    page.getByRole("heading", { name: "Updated Quarto report" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "_introduction.qmd" }),
  ).toHaveAttribute(
    "href",
    `/projects/${projectId}/file?path=sections%2F_introduction.qmd`,
  );
}

test("Source Control renders Quarto Markdown with include navigation", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openQuartoPreview(page, baseURL);
  await capture(page, "source-control-qmd-preview-desktop-1920x1080.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await openQuartoPreview(page, baseURL);
  await capture(page, "source-control-qmd-preview-mobile-375x812.png");
});
