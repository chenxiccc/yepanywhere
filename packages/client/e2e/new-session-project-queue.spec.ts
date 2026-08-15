import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const requestHeaders = {
  "Content-Type": "application/json",
  "X-Yep-Anywhere": "true",
};

let createdItemIds: string[] = [];
let dispatchWasPaused = false;

test.beforeEach(async ({ request, baseURL }) => {
  createdItemIds = [];
  const queueResponse = await request.get(`${baseURL}/api/project-queue`, {
    headers: { "X-Yep-Anywhere": "true" },
  });
  expect(queueResponse.ok()).toBeTruthy();
  const queue = (await queueResponse.json()) as {
    dispatchState: { status: string };
  };
  dispatchWasPaused = queue.dispatchState.status === "paused";

  const titles = [
    "Review the responsive queue placement",
    "Verify durable queued-session feedback",
  ];
  for (const [index, title] of titles.entries()) {
    const response = await request.post(
      `${baseURL}/api/projects/${projectId}/queue`,
      {
        headers: requestHeaders,
        data: {
          target: { type: "new-session", provider: "claude", title },
          message: { text: title },
          createdFrom: { client: "new-session" },
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { item: { id: string } };
    createdItemIds.push(body.item.id);

    if (index === 0 && !dispatchWasPaused) {
      const pauseResponse = await request.post(
        `${baseURL}/api/project-queue/pause`,
        { headers: { "X-Yep-Anywhere": "true" } },
      );
      expect(pauseResponse.ok()).toBeTruthy();
    }
  }
});

test.afterEach(async ({ request, baseURL }) => {
  for (const itemId of createdItemIds) {
    await request.delete(
      `${baseURL}/api/projects/${projectId}/queue/${encodeURIComponent(itemId)}`,
      { headers: { "X-Yep-Anywhere": "true" } },
    );
  }
  if (!dispatchWasPaused) {
    await request.post(`${baseURL}/api/project-queue/resume`, {
      headers: { "X-Yep-Anywhere": "true" },
    });
  }
});

async function assertQueueFollowsSelector(
  page: import("@playwright/test").Page,
  layout: "wide" | "narrow",
) {
  const selector = page.locator(".new-session-project-chooser");
  const queue = page.locator(
    '.new-session-project-chooser + [data-new-session-project-queue="true"]',
  );
  const provider = page.locator(".new-session-provider-slot");

  await expect(selector).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(queue).toContainText("Project Queue");
  await expect(queue).toContainText("2 queued");
  await expect(queue).toContainText("Review the responsive queue placement");
  await expect(queue).toContainText("Verify durable queued-session feedback");

  const selectorBox = await selector.boundingBox();
  const queueBox = await queue.boundingBox();
  const providerBox = await provider.boundingBox();
  expect(selectorBox).not.toBeNull();
  expect(queueBox).not.toBeNull();
  expect(providerBox).not.toBeNull();
  if (!selectorBox || !queueBox || !providerBox) return;

  expect(Math.abs(queueBox.x - selectorBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(queueBox.width - selectorBox.width)).toBeLessThanOrEqual(1);
  expect(queueBox.y).toBeGreaterThan(selectorBox.y + selectorBox.height);

  if (layout === "wide") {
    expect(queueBox.x).toBeGreaterThan(providerBox.x + providerBox.width);
  } else {
    expect(providerBox.y).toBeGreaterThan(queueBox.y + queueBox.height);
  }
}

test("keeps the selected project queue beneath the selector", async ({
  page,
  baseURL,
}) => {
  const captureDir =
    process.env.YEP_NEW_SESSION_QUEUE_CAPTURE_DIR ??
    join(e2ePaths.tempDir, "new-session-project-queue-captures");
  mkdirSync(captureDir, { recursive: true });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/new-session?projectId=${projectId}`);
  await assertQueueFollowsSelector(page, "wide");
  await page.screenshot({
    path: join(captureDir, "desktop-1920x1080.png"),
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await assertQueueFollowsSelector(page, "wide");
  await page.screenshot({
    path: join(captureDir, "wide-1024x768.png"),
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await assertQueueFollowsSelector(page, "narrow");
  await page.screenshot({
    path: join(captureDir, "mobile-375x812.png"),
  });
});
