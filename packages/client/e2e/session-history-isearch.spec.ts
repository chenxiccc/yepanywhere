import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "history-search-001";

async function captureSearchPanel(
  page: Page,
  testInfo: TestInfo,
  viewportName: string,
) {
  const body = await page.screenshot({ animations: "disabled" });
  await testInfo.attach(`history-isearch-${viewportName}`, {
    body,
    contentType: "image/png",
  });
  const captureDir = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      path: join(captureDir, `${viewportName}.png`),
    });
  }
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`continues isearch through bounded history at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const consoleFailures: string[] = [];
    const pageErrors: string[] = [];
    const olderPageRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        consoleFailures.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.has("beforeMessageId")) {
        olderPageRequests.push(url.searchParams.get("beforeMessageId") ?? "");
      }
    });

    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    const list = page.locator(".session-messages .message-list");
    await expect(list.locator('[data-render-id="history-user-9"]')).toBeVisible(
      {
        timeout: 10000,
      },
    );
    await expect(list).not.toHaveAttribute("aria-busy", "true", {
      timeout: 10000,
    });
    await page.addStyleTag({
      content: ".message-list [data-render-id] { min-height: 120px; }",
    });

    await page.keyboard.press("Control+r");
    const input = page.getByRole("textbox", {
      name: "Reverse search user turns",
    });
    await input.fill("horizon needle");
    await expect(list.locator('[data-render-id="history-user-0"]')).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Search older" }).click();
    const moreButton = page.getByRole("button", { name: "More" });
    const startReached = page.getByText("Start of session reached", {
      exact: true,
    });
    const olderResult = page.getByText("Older result", { exact: true });
    let moreClicks = 0;
    for (let attempts = 0; attempts < 4; attempts += 1) {
      await expect
        .poll(
          async () =>
            (await moreButton.isVisible()) || (await startReached.isVisible()),
        )
        .toBe(true);
      if (await startReached.isVisible()) break;
      await moreButton.click();
      moreClicks += 1;
    }
    expect(moreClicks).toBeGreaterThan(0);
    await expect(startReached).toBeVisible();

    await page.keyboard.press("ArrowUp");
    await expect(olderResult).toBeVisible();
    await expect(
      page
        .getByRole("search")
        .getByText("The archived horizon needle is in the oldest page."),
    ).toBeVisible();
    await expect(list.locator('[data-render-id="history-user-0"]')).toHaveCount(
      0,
    );
    expect(olderPageRequests).toContain("history-compact-4");
    expect(olderPageRequests).toContain("history-compact-2");
    const requestsBeforeHydration = olderPageRequests.length;
    await captureSearchPanel(page, testInfo, viewport.name);

    await page.keyboard.press("Enter");
    const historicalTarget = list.locator('[data-render-id="history-user-0"]');
    await expect(historicalTarget).toBeVisible();
    await expect(input).toHaveCount(0);
    await expect(list).toContainText(
      "Unloaded history omitted · recent transcript continues below",
    );
    await expect(list.locator('[data-render-id="history-user-9"]')).toHaveCount(
      1,
    );
    await expect
      .poll(() => olderPageRequests.length)
      .toBe(requestsBeforeHydration + 1);
    const targetOffset = async () => {
      const targetBox = await historicalTarget.boundingBox();
      const viewportBox = await page.locator(".session-messages").boundingBox();
      if (!targetBox || !viewportBox) return null;
      const fullyVisible =
        targetBox.y >= viewportBox.y - 1 &&
        targetBox.y + targetBox.height <=
          viewportBox.y + viewportBox.height + 1;
      return fullyVisible ? targetBox.y - viewportBox.y : null;
    };
    await expect.poll(targetOffset).not.toBeNull();
    const settledTargetOffset = await targetOffset();
    await page.waitForTimeout(100);
    expect(await targetOffset()).toBeCloseTo(settledTargetOffset ?? 0, 0);

    await page.keyboard.press("Control+End");
    await expect(historicalTarget).toHaveCount(0);
    await expect(list).not.toContainText("Unloaded history omitted");
    expect(consoleFailures).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
