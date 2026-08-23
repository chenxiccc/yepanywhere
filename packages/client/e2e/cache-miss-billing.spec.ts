import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

function record(
  id: string,
  overrides: Partial<CacheMissBillingRecord>,
): CacheMissBillingRecord {
  return {
    id,
    timestamp: "2026-08-23T12:00:00.000Z",
    provider: "claude",
    model: "opus",
    sessionId: "session-alpha",
    projectId: "project-alpha" as CacheMissBillingRecord["projectId"],
    sessionPath: "/projects/project-alpha/sessions/session-alpha",
    reason: "warm-session-cache-miss",
    outcome: "unexpected-recompute",
    exception: true,
    messageId: `provider-${id}`,
    messageIndex: 211,
    observedUsage: {
      inputTokens: 12_000,
      totalContextTokens: 12_000,
      uncachedInputTokens: 12_000,
    },
    expectedInputCost: {
      state: "expected-new-content",
      expectedUncachedPrefixTokens: 1_000,
      source: "warm-session",
      prefixBasis: "same-session-prefix",
      freshEnough: true,
      providerFreshWindowMinutes: 60,
    },
    wastedInputTokens: 11_000,
    freshWindowMinutes: 60,
    elapsedSinceExpectedCacheMs: 20_000,
    expectedCacheSource: "warm-session",
    completeProbabilitySample: true,
    ...overrides,
  };
}

const events: CacheMissBillingRecord[] = [
  record("alpha-newest", { messageIndex: 211 }),
  record("alpha-hit", {
    messageIndex: 205,
    outcome: "expected-cache-hit",
    reason: "warm-session-cache-hit",
    exception: false,
    wastedInputTokens: 0,
    elapsedSinceExpectedCacheMs: 45_000,
    observedUsage: {
      inputTokens: 1_000,
      cacheReadTokens: 11_000,
      totalContextTokens: 12_000,
      uncachedInputTokens: 1_000,
    },
  }),
  record("alpha-previous", {
    messageIndex: 198,
    elapsedSinceExpectedCacheMs: 3 * 60_000,
  }),
  record("beta-newest", {
    provider: "codex",
    model: "gpt-5.6",
    sessionId: "session-beta",
    projectId: "project-beta" as CacheMissBillingRecord["projectId"],
    sessionPath: "/projects/project-beta/sessions/session-beta",
    messageIndex: 77,
    elapsedSinceExpectedCacheMs: 10 * 60_000,
  }),
  record("beta-hit", {
    provider: "codex",
    model: "gpt-5.6",
    sessionId: "session-beta",
    projectId: "project-beta" as CacheMissBillingRecord["projectId"],
    sessionPath: "/projects/project-beta/sessions/session-beta",
    messageIndex: 70,
    outcome: "expected-cache-hit",
    reason: "warm-session-cache-hit",
    exception: false,
    wastedInputTokens: 0,
    elapsedSinceExpectedCacheMs: 40 * 60_000,
    observedUsage: {
      inputTokens: 900,
      cacheReadTokens: 10_500,
      totalContextTokens: 11_400,
      uncachedInputTokens: 900,
    },
  }),
];

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

test("filters cache evidence and links events from the same session", async ({
  page,
  baseURL,
}) => {
  await page.route(
    "**/api/settings/cache-miss-billing/events?*",
    async (route) => {
      await route.fulfill({ json: { events } });
    },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/settings/cache-miss-billing`);

  const resultFilter = page.getByRole("combobox", { name: "Result" });
  await expect(resultFilter).toHaveValue("misses");
  await expect(
    page.getByRole("cell", { name: "Miss", exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByRole("cell", { name: "Hit", exact: true }),
  ).toHaveCount(0);

  await resultFilter.selectOption("hits");
  await expect(
    page.getByRole("cell", { name: "Hit", exact: true }),
  ).toHaveCount(2);
  await page.reload();
  await expect(resultFilter).toHaveValue("hits");
  await resultFilter.selectOption("misses");

  const newestRow = page
    .getByText("#211", { exact: true })
    .locator("xpath=ancestor::tr");
  const previousRow = page
    .getByText("#198", { exact: true })
    .locator("xpath=ancestor::tr");
  const otherRow = page
    .getByText("#77", { exact: true })
    .locator("xpath=ancestor::tr");
  const [newestColor, previousColor, otherColor] = await Promise.all([
    newestRow.evaluate((row) =>
      row.style.getPropertyValue("--cache-session-color"),
    ),
    previousRow.evaluate((row) =>
      row.style.getPropertyValue("--cache-session-color"),
    ),
    otherRow.evaluate((row) =>
      row.style.getPropertyValue("--cache-session-color"),
    ),
  ]);
  expect(newestColor).toBe(previousColor);
  expect(newestColor).not.toBe(otherColor);

  await page.getByText("#211", { exact: true }).click();
  await expect(previousRow).toBeFocused();

  const chartHeading = page.getByRole("heading", {
    name: "Re-read tokens by turn gap",
  });
  await chartHeading.scrollIntoViewIfNeeded();
  await expect(page.getByText("0–30s", { exact: true })).toHaveCount(2);
  await expect(page.getByText("30s–1m", { exact: true })).toHaveCount(2);
  await expect(page.getByText("1m–2m", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2m–4m", { exact: true })).toHaveCount(2);
  await expect(page.getByText("32m–64m", { exact: true })).toHaveCount(2);
  await capture(page, "cache-billing-charts-desktop.png");

  const eventsHeading = page.getByRole("heading", { name: "Events" });
  await eventsHeading.scrollIntoViewIfNeeded();
  await capture(page, "cache-billing-events-desktop.png");

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileChartHeading = page.getByRole("heading", {
    name: "Re-read tokens by turn gap",
  });
  await expect(mobileChartHeading).toBeVisible();
  await mobileChartHeading.scrollIntoViewIfNeeded();
  await capture(page, "cache-billing-charts-mobile.png");
  const mobileEventsHeading = page.getByRole("heading", { name: "Events" });
  await expect(mobileEventsHeading).toBeVisible();
  await mobileEventsHeading.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await capture(page, "cache-billing-events-mobile.png");
});
