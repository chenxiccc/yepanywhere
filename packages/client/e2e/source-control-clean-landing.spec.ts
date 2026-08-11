import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const sourceControlProjectPath = join(
  e2ePaths.tempDir,
  "source-control-project",
);
const projectId = Buffer.from(sourceControlProjectPath).toString("base64url");
const cleanLandingKey = "yep-anywhere-source-control-clean-landing";

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

async function openSourceControl(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/git-status?projectId=${projectId}`);
  await dismissOnboardingIfVisible(page);
}

test("clean Changes landing and latest-commit preference stay distinct", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openSourceControl(page, baseURL);
  await page.evaluate((key) => localStorage.removeItem(key), cleanLandingKey);
  await page.reload();

  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No uncommitted changes")).toBeVisible();
  await expect(
    page.getByText("Seed source control fixture", { exact: true }),
  ).toHaveCount(0);
  await capture(page, "source-control-clean-desktop-1920x1080.png");

  await page.getByRole("button", { name: "Commit history" }).click();
  await expect(
    page.getByText("Seed source control fixture", { exact: true }).first(),
  ).toBeVisible();
  const workingTreeRow = page.locator(".commit-list-working-tree");
  await expect(
    workingTreeRow.getByText("Clean", { exact: true }),
  ).toBeVisible();
  await expect(
    workingTreeRow.getByText("No uncommitted changes"),
  ).toBeVisible();
  await expect(
    workingTreeRow.getByText("Uncommitted", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toHaveCount(0);
  await capture(page, "source-control-history-desktop-1920x1080.png");

  await page.goto(`${baseURL}/settings/source-control`);
  const landingSelect = page.getByRole("combobox", {
    name: "When the working tree is clean",
  });
  await expect(landingSelect).toHaveValue("working-tree");
  await landingSelect.selectOption("latest-commit");
  await expect(landingSelect).toHaveValue("latest-commit");
  await capture(page, "source-control-setting-desktop-1920x1080.png");

  await openSourceControl(page, baseURL);
  await expect(
    page.getByText("Seed source control fixture", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/settings/source-control`);
  await expect(landingSelect).toHaveValue("latest-commit");
  await capture(page, "source-control-setting-mobile-375x812.png");
  await landingSelect.selectOption("working-tree");

  await openSourceControl(page, baseURL);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No uncommitted changes")).toBeVisible();
  await capture(page, "source-control-clean-mobile-375x812.png");
});
