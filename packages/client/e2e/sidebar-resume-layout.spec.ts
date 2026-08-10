import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function openSidebar(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/inbox`);
  await dismissOnboardingIfVisible(page);

  const sidebar = page.locator(".sidebar");
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
  }
  await expect(sidebar).toBeVisible();
}

async function findResumeRow(page: Page) {
  const resume = page.getByRole("button", { name: "Resume" }).first();
  await expect(resume).toBeVisible();
  const row = resume.locator("xpath=ancestor::li[1]");
  await expect(row).toBeVisible();
  return row;
}

async function expectResumeClearOfMenu(row: Locator) {
  await row.hover();

  const resume = row.getByRole("button", { name: "Resume" });
  const project = row.locator(".session-list-item__project-compact");
  const menu = row.getByRole("button", { name: "Session options" });
  const titleLink = row.getByRole("link");

  const [resumeBox, projectBox, menuBox, titleBox] = await Promise.all([
    resume.boundingBox(),
    project.boundingBox(),
    menu.boundingBox(),
    titleLink.boundingBox(),
  ]);

  expect(resumeBox).not.toBeNull();
  expect(projectBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(resumeBox!.x + resumeBox!.width).toBeLessThanOrEqual(projectBox!.x);
  expect(resumeBox!.x + resumeBox!.width).toBeLessThanOrEqual(menuBox!.x);
  expect(titleBox!.width).toBeGreaterThan(0);
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

test("keeps compact Resume before the project and clear of the menu", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openSidebar(page, baseURL);
  await expectResumeClearOfMenu(await findResumeRow(page));
  await capture(page, "sidebar-resume-desktop-1920x1080.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await openSidebar(page, baseURL);
  await expectResumeClearOfMenu(await findResumeRow(page));
  await capture(page, "sidebar-resume-mobile-375x812.png");
});
