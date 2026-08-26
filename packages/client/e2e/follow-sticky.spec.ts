import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { SESSION_SCROLL_MEMORY_STORAGE_PREFIX } from "../src/lib/sessionScrollMemoryStorage";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

const viewports = [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const;

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.locator(".onboarding-skip-all");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function bottomGap(page: Page) {
  return page.locator(".message-list").evaluate((list) => {
    const viewport = list.parentElement;
    if (!viewport) throw new Error("Message list has no scroll viewport");
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  });
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

async function installTallTurnFixture(page: Page) {
  await page.addInitScript(() => {
    const apply = () => {
      const row = document.querySelector<HTMLElement>('[data-render-id="1"]');
      if (row && row.style.minHeight !== "1600px") {
        row.style.minHeight = "1600px";
      }
    };
    new MutationObserver(apply).observe(document, {
      childList: true,
      subtree: true,
    });
    apply();
  });
}

async function readSessionScrollMemory(page: Page) {
  return page.evaluate((prefix) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }
    }
    return null;
  }, SESSION_SCROLL_MEMORY_STORAGE_PREFIX);
}

for (const viewport of viewports) {
  test(`keeps one Follow activation sticky on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible({ timeout: 10_000 });

    await page.locator(".message-list").evaluate((list) => {
      const spacer = document.createElement("div");
      spacer.dataset.followRaceSpacer = "true";
      spacer.textContent = "Simulated live output after Follow";
      Object.assign(spacer.style, {
        alignItems: "flex-end",
        display: "flex",
        minHeight: "1200px",
        padding: "16px",
      });
      list.append(spacer);
    });
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      if (!scrollViewport)
        throw new Error("Message list has no scroll viewport");
      scrollViewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
      );
      scrollViewport.scrollTop = Math.max(
        0,
        scrollViewport.scrollHeight - scrollViewport.clientHeight - 400,
      );
      scrollViewport.dispatchEvent(new Event("scroll"));
    });

    const follow = page.getByRole("button", {
      name: "Follow latest session output",
    });
    await expect(follow).toBeVisible();
    await follow.click();
    await expect(follow).not.toBeVisible();

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      const spacer = list.querySelector<HTMLElement>(
        "[data-follow-race-spacer]",
      );
      if (!scrollViewport || !spacer) {
        throw new Error("Follow race fixture is incomplete");
      }
      spacer.style.minHeight = "1800px";
      scrollViewport.dispatchEvent(new Event("scroll"));
    });

    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);
    await expect(follow).not.toBeVisible();
    await expect(
      page.getByText("Simulated live output after Follow"),
    ).toBeVisible();

    await capture(
      page,
      `follow-sticky-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });

  test(`restores Follow at the live tail after return and reload on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await installTallTurnFixture(page);
    const sessionUrl = `${baseURL}/projects/${projectId}/sessions/${sessionId}`;
    await page.goto(sessionUrl);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      if (!scrollViewport) {
        throw new Error("Message list has no scroll viewport");
      }
      scrollViewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
      );
      scrollViewport.scrollTop = Math.max(
        0,
        scrollViewport.scrollHeight - scrollViewport.clientHeight - 400,
      );
      scrollViewport.dispatchEvent(new Event("scroll"));
    });

    const follow = page.getByRole("button", {
      name: "Follow latest session output",
    });
    await expect(follow).toBeVisible();
    await page.evaluate((prefix) => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    }, SESSION_SCROLL_MEMORY_STORAGE_PREFIX);
    await page.locator(".message-list").evaluate((list) => {
      list.parentElement?.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(async () => (await readSessionScrollMemory(page))?.following)
      .toBe(false);

    await follow.click();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);
    await expect
      .poll(async () => (await readSessionScrollMemory(page))?.following)
      .toBe(true);

    const otherSessionPath = `/projects/${projectId}/sessions/speech-caret-001`;
    await page.evaluate((path) => {
      history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, otherSessionPath);
    await expect(page).toHaveURL(`${baseURL}${otherSessionPath}`);
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(sessionUrl);
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await page.reload();
    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await capture(
      page,
      `follow-return-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });
}
