import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  e2ePaths,
  expect,
  setLiveWorktreeMonitoring,
  test,
} from "./fixtures.js";

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

async function installPageAttention(
  page: Page,
  initial: { visibility: DocumentVisibilityState; focused: boolean } = {
    visibility: "visible",
    focused: true,
  },
) {
  await page.addInitScript((startingAttention) => {
    let visibility = startingAttention.visibility;
    let focused = startingAttention.focused;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
    Object.defineProperty(window, "__setTestPageAttention", {
      configurable: true,
      value: (next: {
        visibility: DocumentVisibilityState;
        focused: boolean;
      }) => {
        const visibilityChanged = visibility !== next.visibility;
        const focusChanged = focused !== next.focused;
        visibility = next.visibility;
        focused = next.focused;
        if (visibilityChanged) {
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (focusChanged) {
          window.dispatchEvent(new Event(focused ? "focus" : "blur"));
        }
      },
    });
  }, initial);
}

async function setPageAttention(
  page: Page,
  visibility: DocumentVisibilityState,
  focused: boolean,
) {
  await page.evaluate(
    ({ nextVisibility, nextFocused }) => {
      (
        window as typeof window & {
          __setTestPageAttention: (next: {
            visibility: DocumentVisibilityState;
            focused: boolean;
          }) => void;
        }
      ).__setTestPageAttention({
        visibility: nextVisibility,
        focused: nextFocused,
      });
    },
    { nextVisibility: visibility, nextFocused: focused },
  );
}

function countGitStatusRequests(page: Page) {
  let started = 0;
  let settled = 0;
  const matches = (request: { method(): string; url(): string }): boolean => {
    const url = new URL(request.url());
    return (
      request.method() === "GET" &&
      url.pathname === `/api/projects/${projectId}/git`
    );
  };
  page.on("request", (request) => {
    if (matches(request)) started += 1;
  });
  page.on("requestfinished", (request) => {
    if (matches(request)) settled += 1;
  });
  page.on("requestfailed", (request) => {
    if (matches(request)) settled += 1;
  });
  // A count snapshot used for an exact later +1 assertion must be taken at
  // quiescence: a still-pending status response lets the next forced refresh
  // join that in-flight request (deliberate request coalescing) instead of
  // issuing a new one, which would read as a missing refresh.
  return Object.assign(() => started, {
    settled: () => started === settled,
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

test("retention eviction preserves the mounted workbench", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await installPageAttention(page);
  const statusRequests = countGitStatusRequests(page);
  await openSourceControl(page, baseURL);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await expect.poll(statusRequests.settled).toBe(true);

  await setPageAttention(page, "hidden", false);
  await page.evaluate(() => {
    const retention = window.__YA_ROUTE_RETENTION__;
    if (!retention) {
      throw new Error("Route retention developer API was not published");
    }
    retention.clear();
  });
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
  await capture(page, "source-control-retention-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await capture(page, "source-control-retention-mobile-375x812.png");
});

test("unfocused cold load keeps the static workbench mounted", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await installPageAttention(page, {
    visibility: "visible",
    focused: false,
  });
  await openSourceControl(page, baseURL);

  await expect(page.getByTestId("working-tree-browser")).toBeVisible();
  await expect(page.locator(".page-content-inner > .loading")).toHaveCount(0);
  await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  await expect(page.getByText("No matches.", { exact: true })).toHaveCount(0);
  await capture(page, "source-control-unfocused-load-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId("working-tree-browser")).toBeVisible();
  await capture(page, "source-control-unfocused-load-mobile-375x812.png");

  await setPageAttention(page, "visible", true);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
});

test("status refresh follows route and page attention", async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await installPageAttention(page);
  await page.clock.install();
  const statusRequests = countGitStatusRequests(page);
  await openSourceControl(page, baseURL);
  await expect.poll(statusRequests).toBeGreaterThan(0);

  await page.clock.fastForward(1_000);
  const initialRequests = statusRequests();
  await page.clock.fastForward(10_000);
  expect(statusRequests()).toBe(initialRequests);
  await page.clock.fastForward(25_000);
  await expect.poll(statusRequests).toBeGreaterThan(initialRequests);
  await expect.poll(statusRequests.settled).toBe(true);

  await page.evaluate(() => {
    history.pushState(null, "", "/sessions");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toHaveCount(0);
  const requestsAfterLeaving = statusRequests();
  await page.clock.fastForward(60_000);
  expect(statusRequests()).toBe(requestsAfterLeaving);

  await page.goBack();
  await expect(page).toHaveURL(/\/git-status\?/);
  await expect(
    page.getByText("Working tree clean", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect.poll(statusRequests).toBeGreaterThan(requestsAfterLeaving);
  await expect.poll(statusRequests.settled).toBe(true);
  const requestsAfterReturning = statusRequests();

  await setPageAttention(page, "hidden", false);
  await page.clock.fastForward(60_000);
  expect(statusRequests()).toBe(requestsAfterReturning);

  await setPageAttention(page, "visible", false);
  await page.clock.fastForward(60_000);
  expect(statusRequests()).toBe(requestsAfterReturning);

  await setPageAttention(page, "visible", true);
  await expect.poll(statusRequests).toBe(requestsAfterReturning + 1);

  const backgroundPage = await context.newPage();
  await backgroundPage.setViewportSize({ width: 1000, height: 600 });
  await installPageAttention(backgroundPage, {
    visibility: "hidden",
    focused: false,
  });
  await backgroundPage.clock.install();
  const backgroundRequests = countGitStatusRequests(backgroundPage);
  await openSourceControl(backgroundPage, baseURL);
  await expect.poll(backgroundRequests).toBeGreaterThan(0);
  await expect.poll(backgroundRequests.settled).toBe(true);
  const initialBackgroundRequests = backgroundRequests();

  await backgroundPage.clock.fastForward(60_000);
  expect(backgroundRequests()).toBe(initialBackgroundRequests);
  await setPageAttention(backgroundPage, "visible", true);
  await expect.poll(backgroundRequests).toBe(initialBackgroundRequests + 1);
  await backgroundPage.close();
});

test("commit search keeps the matching preview text visible", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/git-status?projectId=${projectId}&history=1`);
  await dismissOnboardingIfVisible(page);
  await expect(page).toHaveURL(/(?:\?|&)history=1/);

  // At 1000 px the compact layout opens the preferred clean-tree commit once
  // its history loads. Wait for that transition to settle, then return to the
  // revision list before starting the search.
  await expect(page.getByRole("button", { name: "To HEAD" })).toBeVisible();
  await page.getByRole("button", { name: "Commit history" }).click();
  const search = page.getByPlaceholder("Search commit changes…");
  await expect(search).toBeVisible();
  await search.fill("Z");
  await expect(page.getByText("Z", { exact: true })).toHaveCount(1, {
    timeout: 10_000,
  });
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

let liveWorktreeMonitoringActive = false;
test.afterEach(async ({ baseURL }) => {
  if (!liveWorktreeMonitoringActive) return;
  liveWorktreeMonitoringActive = false;
  await setLiveWorktreeMonitoring(baseURL, false);
});

test("groups semantic file sections and keeps current-content browsing distinct", async ({
  page,
  baseURL,
}) => {
  liveWorktreeMonitoringActive = true;
  await setLiveWorktreeMonitoring(baseURL, true);
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
    page.getByRole("button", { name: "Tracked", exact: true }).last(),
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
    page.getByRole("button", { name: "Tracked", exact: true }).last(),
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
