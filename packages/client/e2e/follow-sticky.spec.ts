import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { SESSION_SCROLL_MEMORY_STORAGE_PREFIX } from "../src/lib/sessionScrollMemoryStorage";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  restartYaServerProcess,
  startYaServerProcess,
  stopYaServerProcess,
  type YaServerProcess,
} from "./support/ya-server-process.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";
const scrollMemorySessionId = "scroll-memory-001";

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

async function clickSidebarSession(page: Page, sessionPath: string) {
  const sidebar = page.locator(".sidebar");
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(sidebar).toBeVisible();
  }
  const sessionLink = sidebar.locator(`a[href="${sessionPath}"]`).first();
  await expect(sessionLink).toBeVisible();
  await sessionLink.click();
}

async function readSessionScrollMemory(page: Page, targetSessionId: string) {
  return page.evaluate(
    ({ prefix, targetSessionId }) => {
      const suffix = `:${encodeURIComponent(targetSessionId)}`;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix) && key.endsWith(suffix)) {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        }
      }
      return null;
    },
    { prefix: SESSION_SCROLL_MEMORY_STORAGE_PREFIX, targetSessionId },
  );
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
    const sessionUrl = `${baseURL}/projects/${projectId}/sessions/${scrollMemorySessionId}`;
    await page.goto(sessionUrl);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Scroll memory fixture"),
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
      .poll(
        async () =>
          (await readSessionScrollMemory(page, scrollMemorySessionId))
            ?.following,
      )
      .toBe(false);

    await follow.click();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);
    await expect
      .poll(
        async () =>
          (await readSessionScrollMemory(page, scrollMemorySessionId))
            ?.following,
      )
      .toBe(true);

    const otherSessionPath = `/projects/${projectId}/sessions/user-turn-presentation-001`;
    await clickSidebarSession(page, otherSessionPath);
    await expect(page).toHaveURL(`${baseURL}${otherSessionPath}`);
    await expect(
      page
        .getByRole("main")
        .getByText("The short-width-dependent turn is complete."),
    ).toBeVisible();

    await clickSidebarSession(
      page,
      `/projects/${projectId}/sessions/${scrollMemorySessionId}`,
    );
    await expect(page).toHaveURL(sessionUrl);
    await expect(
      page.getByRole("main").getByText("Scroll memory fixture"),
    ).toBeVisible();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await page.reload();
    await expect(
      page.getByRole("main").getByText("Scroll memory fixture"),
    ).toBeVisible();
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4);

    await capture(
      page,
      `follow-return-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });

  test(`keeps sidebar return at the high-water position after scrolling up on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-session-scroll-behavior",
        "remember-place",
      );
    });
    const sessionPath = `/projects/${projectId}/sessions/${scrollMemorySessionId}`;
    const sessionUrl = `${baseURL}${sessionPath}`;
    await page.goto(sessionUrl);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Scroll memory fixture"),
    ).toBeVisible({ timeout: 10_000 });

    await page.evaluate((prefix) => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    }, SESSION_SCROLL_MEMORY_STORAGE_PREFIX);
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
        scrollViewport.scrollHeight - scrollViewport.clientHeight - 250,
      );
      scrollViewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(
        async () =>
          (await readSessionScrollMemory(page, scrollMemorySessionId))
            ?.following,
      )
      .toBe(false);
    const highWaterSnapshot = await readSessionScrollMemory(
      page,
      scrollMemorySessionId,
    );
    expect(highWaterSnapshot).not.toBeNull();

    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      if (!scrollViewport) {
        throw new Error("Message list has no scroll viewport");
      }
      scrollViewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -400 }),
      );
      scrollViewport.scrollTop = Math.max(0, scrollViewport.scrollTop - 400);
      scrollViewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => readSessionScrollMemory(page, scrollMemorySessionId))
      .toEqual(highWaterSnapshot);

    const otherSessionPath = `/projects/${projectId}/sessions/user-turn-presentation-001`;
    await clickSidebarSession(page, otherSessionPath);
    await expect(page).toHaveURL(`${baseURL}${otherSessionPath}`);
    await expect
      .poll(() => readSessionScrollMemory(page, scrollMemorySessionId))
      .toEqual(highWaterSnapshot);
    await clickSidebarSession(page, sessionPath);
    await expect(page).toHaveURL(sessionUrl);
    await expect
      .poll(async () => {
        const restoredTop = await page
          .locator(".message-list")
          .evaluate((list) => list.parentElement?.scrollTop ?? -1);
        return Math.abs(restoredTop - highWaterSnapshot.scrollTop);
      })
      .toBeLessThanOrEqual(2);

    await page.reload();
    await expect(
      page.getByRole("main").getByText("Scroll memory fixture"),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const restoredTop = await page
          .locator(".message-list")
          .evaluate((list) => list.parentElement?.scrollTop ?? -1);
        return Math.abs(restoredTop - highWaterSnapshot.scrollTop);
      })
      .toBeLessThanOrEqual(2);

    await capture(
      page,
      `high-water-return-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });
}

test("restores the high-water position after a server restart and reload", async ({
  page,
}) => {
  await page.setViewportSize(viewports[0]);
  await page.addInitScript(() => {
    localStorage.setItem(
      "yep-anywhere-session-scroll-behavior",
      "remember-place",
    );
  });
  const restartProjectPath = join(
    e2ePaths.tempDir,
    "restart-scroll-memory-project",
  );
  const restartProjectId =
    Buffer.from(restartProjectPath).toString("base64url");
  const restartSessionId = "restart-scroll-memory-001";
  const longContent = Array.from(
    { length: 180 },
    (_, index) => `Server restart paragraph ${index + 1}.`,
  ).join("\n\n");
  let server: YaServerProcess | null = await startYaServerProcess({
    label: "scroll memory restart server",
    mockClaudeSession: {
      assistantContent: longContent,
      content: "Server restart scroll fixture",
      projectPath: restartProjectPath,
      sessionId: restartSessionId,
    },
    env: {
      CLIENT_DIST_PATH: join(process.cwd(), "dist"),
      SERVE_FRONTEND: "true",
    },
  });

  try {
    const sessionUrl = `${server.baseUrl}/projects/${restartProjectId}/sessions/${restartSessionId}`;
    await page.goto(sessionUrl);
    await dismissOnboardingIfVisible(page);
    await expect(
      page.getByRole("main").getByText("Server restart scroll fixture"),
    ).toBeVisible({ timeout: 10_000 });
    await page.evaluate((prefix) => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    }, SESSION_SCROLL_MEMORY_STORAGE_PREFIX);
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
        scrollViewport.scrollHeight - scrollViewport.clientHeight - 250,
      );
      scrollViewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(
        async () =>
          (await readSessionScrollMemory(page, restartSessionId))?.following,
      )
      .toBe(false);
    const highWaterSnapshot = await readSessionScrollMemory(
      page,
      restartSessionId,
    );
    expect(highWaterSnapshot).not.toBeNull();

    await page.locator(".message-list").evaluate((list) => {
      const scrollViewport = list.parentElement;
      if (!scrollViewport) {
        throw new Error("Message list has no scroll viewport");
      }
      scrollViewport.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -400 }),
      );
      scrollViewport.scrollTop = Math.max(0, scrollViewport.scrollTop - 400);
      scrollViewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => readSessionScrollMemory(page, restartSessionId))
      .toEqual(highWaterSnapshot);

    server = await restartYaServerProcess(server);
    await page.reload();
    await expect(
      page.getByRole("main").getByText("Server restart scroll fixture"),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => {
        const restoredTop = await page
          .locator(".message-list")
          .evaluate((list) => list.parentElement?.scrollTop ?? -1);
        return Math.abs(restoredTop - highWaterSnapshot.scrollTop);
      })
      .toBeLessThanOrEqual(2);
  } finally {
    stopYaServerProcess(server);
  }
});
