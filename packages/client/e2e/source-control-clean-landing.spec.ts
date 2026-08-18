import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const sourceControlProjectPath = join(
  e2ePaths.tempDir,
  "source-control-project",
);
const projectId = Buffer.from(sourceControlProjectPath).toString("base64url");
const cleanLandingKey = "yep-anywhere-source-control-clean-landing";
const longSearchLine =
  "prefix/that/is/intentionally/long/enough/to/be/truncated/while/searching/ZebraNeedle/and/a/long/trailing/suffix/for/the/source/control/result";

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

function prepareBrowsingFixture() {
  const groupedDirectory = join(sourceControlProjectPath, "src", "grouped");
  mkdirSync(groupedDirectory, { recursive: true });
  const headSubject = execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: sourceControlProjectPath,
    encoding: "utf8",
  }).trim();
  if (headSubject !== "Add grouped browser fixture") {
    writeFileSync(
      join(groupedDirectory, "modified.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      join(groupedDirectory, "unchanged.ts"),
      "export const stable = true;\n",
    );
    execFileSync("git", ["add", "src/grouped"], {
      cwd: sourceControlProjectPath,
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
        "Add grouped browser fixture",
      ],
      { cwd: sourceControlProjectPath },
    );
  }

  writeFileSync(
    join(groupedDirectory, "modified.ts"),
    "export const value = 2;\n",
  );
  writeFileSync(
    join(groupedDirectory, "added.ts"),
    "export const added = true;\n",
  );
  execFileSync("git", ["add", "src/grouped/added.ts"], {
    cwd: sourceControlProjectPath,
  });
  const scratchDirectory = join(sourceControlProjectPath, "scratch", "grouped");
  mkdirSync(scratchDirectory, { recursive: true });
  writeFileSync(
    join(scratchDirectory, "live.txt"),
    "untracked current contents\n",
  );
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

test("commit search keeps the matching preview text visible", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openSourceControl(page, baseURL);
  await page.getByRole("button", { name: "Commit history" }).click();
  await expect(page).toHaveURL(/(?:\?|&)history=1/);

  const search = page.getByPlaceholder("Search commit changes…");
  const comparison = page.getByRole("button", { name: "To HEAD" });
  await expect
    .poll(
      async () => (await search.isVisible()) || (await comparison.isVisible()),
    )
    .toBe(true);
  if (await comparison.isVisible()) {
    await page.getByRole("button", { name: "Commit history" }).click();
  }
  await expect(search).toBeVisible();
  await search.fill("Z");
  await expect(page.getByText("Z", { exact: true })).toHaveCount(1);
  await search.fill("ZebraNeedle");

  const match = page.getByText("ZebraNeedle", { exact: true });
  const context = match.locator("..");
  await expect(match).toHaveText("ZebraNeedle");
  await expect(context).toHaveText(longSearchLine);
  await expect(context).toHaveAttribute("data-tooltip", longSearchLine);
  await expectMatchInsidePreview(context, match);
  await capture(page, "source-control-search-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  const historyParent = page.getByRole("button", { name: "Commit history" });
  if (await historyParent.isVisible()) await historyParent.click();
  await expect(context).toBeVisible();
  await expectMatchInsidePreview(context, match);
  await capture(page, "source-control-search-mobile-375x812.png");
});

test("groups semantic file sections and keeps current-content browsing distinct", async ({
  page,
  baseURL,
}) => {
  prepareBrowsingFixture();
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(
    `${baseURL}/git-status?projectId=${projectId}&worktreeFile=scratch%2Fgrouped%2Flive.txt`,
  );
  await dismissOnboardingIfVisible(page);

  const changedGroup = page.getByRole("button", {
    name: /^(?:Collapse|Expand) src\/grouped\/ \(2 files\)$/,
  });
  await expect(changedGroup).toBeVisible();
  if ((await changedGroup.getAttribute("aria-expanded")) === "false") {
    await changedGroup.click();
  }
  await expect(changedGroup).toHaveAttribute("aria-expanded", "true");
  await expect(
    changedGroup.getByRole("img", { name: "A — Added" }),
  ).toBeVisible();
  await expect(
    changedGroup.getByRole("img", { name: "M — Modified" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-source-path="src/grouped/modified.ts"]'),
  ).toHaveText("modified.ts");
  await expect(page.getByText("Untracked", { exact: true })).toBeVisible();

  const currentContentDialog = page.getByRole("dialog");
  await expect(
    currentContentDialog.getByText("untracked current contents"),
  ).toBeVisible();
  await capture(page, "source-control-browsing-content-desktop-1000x600.png");
  await page.keyboard.press("Escape");
  await expect(currentContentDialog).toBeHidden();
  await capture(page, "source-control-browsing-changes-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('[data-source-path="scratch/grouped/live.txt"]').click();
  await expect(
    currentContentDialog.getByText("untracked current contents"),
  ).toBeVisible();
  await capture(page, "source-control-browsing-content-mobile-375x812.png");
  await page.keyboard.press("Escape");
  await expect(currentContentDialog).toBeHidden();
  await expect(changedGroup).toBeVisible();
  await expect(page.getByText("Untracked", { exact: true })).toBeVisible();
  await capture(page, "source-control-browsing-changes-mobile-375x812.png");

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/git-status?projectId=${projectId}&tab=files`);
  await expect(
    page.getByText("Tracked, unchanged", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-source-path="src/grouped/unchanged.ts"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-source-path="scratch/grouped/live.txt"]'),
  ).toBeVisible();
  await capture(page, "source-control-browsing-files-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(
    page.getByText("Tracked, unchanged", { exact: true }),
  ).toBeVisible();
  await capture(page, "source-control-browsing-files-mobile-375x812.png");

  await page.setViewportSize({ width: 1000, height: 600 });
  await openSourceControl(page, baseURL);
  await page.getByRole("button", { name: "Commit history" }).click();
  await page
    .getByText("Add grouped browser fixture", { exact: true })
    .first()
    .click();
  const inclusive = page.getByRole("button", { name: "To HEAD" });
  await expect(inclusive).toBeVisible();
  await inclusive.click();
  await expect(inclusive).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", {
      name: /^(?:Collapse|Expand) src\/grouped\/ \(2 files\)$/,
    }),
  ).toBeVisible();
  await capture(page, "source-control-browsing-range-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(inclusive).toBeVisible();
  await capture(page, "source-control-browsing-range-mobile-375x812.png");
});

async function expectMatchInsidePreview(
  preview: ReturnType<Page["locator"]>,
  match: ReturnType<Page["locator"]>,
) {
  const previewBox = await preview.boundingBox();
  const matchBox = await match.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(matchBox).not.toBeNull();
  if (!previewBox || !matchBox) return;
  expect(matchBox.x).toBeGreaterThanOrEqual(previewBox.x - 0.5);
  expect(matchBox.x + matchBox.width).toBeLessThanOrEqual(
    previewBox.x + previewBox.width + 0.5,
  );
  await expect
    .poll(() =>
      preview.evaluate((element) =>
        Array.from(element.children).some((child) => {
          const measurement = child.cloneNode(true) as HTMLElement;
          measurement.style.position = "fixed";
          measurement.style.visibility = "hidden";
          measurement.style.width = "max-content";
          measurement.style.maxWidth = "none";
          measurement.style.flex = "none";
          document.body.append(measurement);
          const naturalWidth = measurement.getBoundingClientRect().width;
          measurement.remove();
          return naturalWidth > child.getBoundingClientRect().width + 0.5;
        }),
      ),
    )
    .toBe(true);
}
