import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skipAll = page.locator(".onboarding-skip-all");
  await page.waitForTimeout(250);
  if (!(await skipAll.isVisible().catch(() => false))) return;
  await skipAll.click({ force: true });
  await expect(skipAll).not.toBeVisible();
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

async function setSidebarSpacing(
  page: Page,
  baseURL: string,
  spacing: "compact" | "comfortable",
) {
  await page.goto(baseURL);
  await page.evaluate((value) => {
    window.localStorage.setItem("yep-anywhere-sidebar-spacing", value);
  }, spacing);
  await openSidebar(page, baseURL);
  await expect(page.locator("html")).toHaveAttribute(
    "data-sidebar-spacing",
    spacing,
  );
}

async function findResumeRow(page: Page) {
  const resume = page.getByRole("button", { name: "Resume" }).first();
  await expect(resume).toBeVisible();
  const row = resume.locator("xpath=ancestor::li[1]");
  await expect(row).toBeVisible();
  return row;
}

async function expectDenseOverlayLayout(row: Locator) {
  const resume = row.getByRole("button", { name: "Resume" });
  const project = row.locator(".session-list-item__project-compact");
  const menu = row.getByRole("button", { name: "Session options" });
  const menuWrapper = menu.locator("xpath=parent::*");
  const titleLink = row.getByRole("link");

  const [rowBox, resumeBox, projectBox, titleBox] = await Promise.all([
    row.boundingBox(),
    resume.boundingBox(),
    project.boundingBox(),
    titleLink.boundingBox(),
  ]);

  expect(rowBox).not.toBeNull();
  expect(resumeBox).not.toBeNull();
  expect(projectBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(resumeBox!.x + resumeBox!.width).toBeLessThanOrEqual(projectBox!.x);
  expect(projectBox!.x - (resumeBox!.x + resumeBox!.width)).toBeLessThanOrEqual(
    16,
  );
  const resumeStyle = await resume.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      marginRight: style.marginRight,
      minWidth: style.minWidth,
    };
  });
  expect(resumeStyle).toEqual({ marginRight: "0px", minWidth: "auto" });
  expect(titleBox!.width).toBeGreaterThan(0);
  await expect(menuWrapper).toHaveCSS("position", "absolute");

  await row.hover();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height / 2).toBeCloseTo(
    rowBox!.y + rowBox!.height / 2,
    0,
  );
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

test("keeps sidebar Resume dense and overlays the row menu", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setSidebarSpacing(page, baseURL, "comfortable");
  await expectDenseOverlayLayout(await findResumeRow(page));
  await capture(page, "sidebar-resume-comfortable-desktop-1920x1080.png");

  await setSidebarSpacing(page, baseURL, "compact");
  await expectDenseOverlayLayout(await findResumeRow(page));
  await capture(page, "sidebar-resume-compact-desktop-1920x1080.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await setSidebarSpacing(page, baseURL, "compact");
  await expectDenseOverlayLayout(await findResumeRow(page));
  await capture(page, "sidebar-resume-compact-mobile-375x812.png");

  await setSidebarSpacing(page, baseURL, "comfortable");
  await expectDenseOverlayLayout(await findResumeRow(page));
  await capture(page, "sidebar-resume-comfortable-mobile-375x812.png");
});
