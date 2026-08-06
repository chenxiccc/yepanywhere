import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name) });
}

const staleGateway = {
  name: "claude-gateway",
  displayName: "Claude Gateway",
  installed: true,
  authenticated: true,
  enabled: true,
  models: [{ id: "saved-gateway", name: "Saved Gateway" }],
};

const currentGateway = {
  ...staleGateway,
  models: [{ id: "current-gateway", name: "Current Gateway" }],
};

test.describe("New Session provider readiness", () => {
  test("keeps stale Gateway display blocked until named retry succeeds", async ({
    page,
    baseURL,
  }) => {
    const aggregateGate = gate();
    const firstNamedGate = gate();
    const retryGate = gate();
    let aggregateRequests = 0;
    let namedRequests = 0;
    let usageRequests = 0;

    await page.route(
      (url) => url.pathname === "/api/providers",
      async (route) => {
        aggregateRequests += 1;
        await aggregateGate.promise;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ providers: [staleGateway] }),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/providers/claude-gateway",
      async (route) => {
        namedRequests += 1;
        if (namedRequests === 1) {
          await firstNamedGate.promise;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "gateway unavailable" }),
          });
          return;
        }
        await retryGate.promise;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ provider: currentGateway }),
        });
      },
    );
    await page.route(
      (url) =>
        url.pathname === "/api/providers/claude-gateway/subscription-usage",
      async (route) => {
        usageRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ usage: null }),
        });
      },
    );

    await page.goto(
      `${baseURL}/new-session?provider=claude-gateway&detached=1`,
    );
    await dismissOnboardingIfVisible(page);
    await page
      .getByPlaceholder("Describe what you'd like help with...")
      .fill("Verify Gateway readiness");

    await expect.poll(() => aggregateRequests).toBe(1);
    await expect.poll(() => namedRequests).toBe(1);
    expect(usageRequests).toBe(0);

    aggregateGate.open();
    await expect(page.getByText("Saved Gateway").first()).toBeVisible();
    await expect(
      page.getByText("Checking the configured gateway for models…"),
    ).toBeVisible();
    await expect(page.locator(".new-session-submit-button")).toBeDisabled();
    expect(usageRequests).toBe(0);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await capture(page, "gateway-checking-desktop-1920x1080.png");
    await page.setViewportSize({ width: 375, height: 812 });
    await capture(page, "gateway-checking-mobile-375x812.png");

    firstNamedGate.open();
    await expect(
      page.getByText(
        "No models are available from the configured gateway. Check that it is running, then retry.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Saved Gateway").first()).toBeVisible();
    await expect(page.locator(".new-session-submit-button")).toBeDisabled();
    await expect.poll(() => usageRequests).toBe(1);

    const aggregateRequestsBeforeRetry = aggregateRequests;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => namedRequests).toBe(2);
    expect(aggregateRequests).toBe(aggregateRequestsBeforeRetry);
    await expect(page.locator(".new-session-submit-button")).toBeDisabled();

    retryGate.open();
    await expect(page.getByText("Current Gateway").first()).toBeVisible();
    await expect(
      page.getByText("Checking the configured gateway for models…"),
    ).toHaveCount(0);
    await expect(page.locator(".new-session-submit-button")).toBeEnabled();

    await page.setViewportSize({ width: 1920, height: 1080 });
    await capture(page, "gateway-ready-desktop-1920x1080.png");
    await page.setViewportSize({ width: 375, height: 812 });
    await capture(page, "gateway-ready-mobile-375x812.png");
  });

  test("keeps a fresh empty Gateway catalog blocked", async ({
    page,
    baseURL,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/providers",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ providers: [staleGateway] }),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/providers/claude-gateway",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            provider: { ...currentGateway, models: [] },
          }),
        });
      },
    );

    await page.goto(
      `${baseURL}/new-session?provider=claude-gateway&detached=1`,
    );
    await dismissOnboardingIfVisible(page);
    await page
      .getByPlaceholder("Describe what you'd like help with...")
      .fill("Verify empty Gateway catalog");

    await expect(
      page.getByText(
        "No models are available from the configured gateway. Check that it is running, then retry.",
      ),
    ).toBeVisible();
    await expect(page.locator(".new-session-submit-button")).toBeDisabled();
  });
});
