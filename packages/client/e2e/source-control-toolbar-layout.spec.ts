import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const projectPath = join(e2ePaths.tempDir, "source-control-qmd-project");
const fileName =
  "claude-gateway-process-start-and-output-collector-with-an-intentionally-long-layout-name-that-wraps-at-medium-width.ts";
const relativePath = `src/${fileName}`;
const filePath = join(projectPath, relativePath);
const projectId = Buffer.from(projectPath).toString("base64url");

test.use({ serviceWorkers: "block" });

test.beforeAll(() => {
  mkdirSync(join(projectPath, "src"), { recursive: true });
  writeFileSync(filePath, "export const toolbarLayoutFixture = false;\n");
  execFileSync("git", ["add", relativePath], {
    cwd: projectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed toolbar layout fixture",
    ],
    { cwd: projectPath, stdio: "ignore" },
  );
  writeFileSync(filePath, "export const toolbarLayoutFixture = true;\n");
});

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

async function narrowDetailPane(toolbar: Locator, splitter: Locator) {
  for (let step = 0; step < 30; step += 1) {
    const box = await toolbar.boundingBox();
    if (box && box.width < 500) return;
    await splitter.press("ArrowRight");
  }
  expect((await toolbar.boundingBox())?.width).toBeLessThan(500);
}

test("narrow diff panes put wrapping file identity below controls", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(
    `${baseURL}/git-status?projectId=${projectId}&worktreeFile=${encodeURIComponent(relativePath)}`,
  );
  await dismissOnboardingIfVisible(page);

  const toolbar = page.locator(".git-diff-pane-toolbar");
  const identity = toolbar.locator(":scope > .git-diff-file-identity");
  const title = identity.locator(".git-diff-preview-title");
  const splitter = page
    .locator(".source-pane-splitter-files .source-pane-splitter-handle.top")
    .first();
  await expect(toolbar).toBeVisible();
  await expect(title).toHaveText(fileName);
  await expect(splitter).toBeVisible();
  await narrowDetailPane(toolbar, splitter);

  const identityBox = await identity.boundingBox();
  const controlBoxes = await toolbar
    .locator(
      ":scope > .diff-context-buttons, :scope > .git-diff-preview-header-actions",
    )
    .evaluateAll((groups) =>
      groups.map((group) => {
        const box = group.getBoundingClientRect();
        return { bottom: box.bottom, top: box.top };
      }),
    );
  expect(identityBox).not.toBeNull();
  expect(controlBoxes.length).toBeGreaterThan(0);
  expect(identityBox?.y ?? 0).toBeGreaterThanOrEqual(
    Math.max(...controlBoxes.map((box) => box.bottom)) - 0.5,
  );
  await expect
    .poll(() =>
      title.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        overflowWrap: getComputedStyle(element).overflowWrap,
        whiteSpace: getComputedStyle(element).whiteSpace,
      })),
    )
    .toMatchObject({ overflowWrap: "anywhere", whiteSpace: "normal" });
  expect((await title.boundingBox())?.height).toBeGreaterThan(20);
  await capture(page, "source-control-toolbar-desktop-1200x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(fileName);
  await capture(page, "source-control-toolbar-mobile-375x812.png");
});
