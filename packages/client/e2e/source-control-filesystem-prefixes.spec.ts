import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  e2ePaths,
  expect,
  setLiveWorktreeMonitoring,
  test,
} from "./fixtures.js";

const projectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(projectPath).toString("base64url");

test.use({ serviceWorkers: "block" });

function prepareFilesystemFixture() {
  mkdirSync(join(projectPath, "docs"), { recursive: true });
  mkdirSync(join(projectPath, "src", "components"), { recursive: true });
  writeFileSync(join(projectPath, "root.txt"), "root file\n");
  writeFileSync(join(projectPath, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(projectPath, "src", "index.ts"), "export {};\n");
  writeFileSync(
    join(projectPath, "src", "components", "Button.tsx"),
    "export function Button() { return <button />; }\n",
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

test.beforeEach(async ({ baseURL }) => {
  await setLiveWorktreeMonitoring(baseURL, true);
});

test.afterEach(async ({ baseURL }) => {
  await setLiveWorktreeMonitoring(baseURL, false);
});

test("opens filesystem directories one level at a time", async ({
  page,
  baseURL,
}) => {
  prepareFilesystemFixture();
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/git-status?projectId=${projectId}&tab=files`);

  await expect(page.locator('[data-source-path="root.txt"]')).toBeVisible();
  const docs = page.getByRole("button", {
    name: "Expand directory docs/",
  });
  const src = page.getByRole("button", {
    name: "Expand directory src/",
  });
  await expect(docs).toBeVisible();
  await expect(src).toBeVisible();
  await expect(docs.locator('[class*="groupCount"]')).toHaveCount(0);
  await expect(page.locator('[data-source-path="docs/guide.md"]')).toHaveCount(
    0,
  );

  await src.click();
  await expect(page.locator('[data-source-path="src/index.ts"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand directory src/components/" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-source-path="src/components/Button.tsx"]'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await capture(page, "filesystem-prefixes-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('[data-source-path="src/index.ts"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand directory src/components/" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await capture(page, "filesystem-prefixes-mobile-375x812.png");
});
