import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "provider-child-layout-001";
const agentId = "layout-child";

const viewports = [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const;

test.use({ serviceWorkers: "block" });

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

async function layoutColumns(header: Locator) {
  return header.evaluate((element) =>
    getComputedStyle(element)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .filter(Boolean),
  );
}

for (const viewport of viewports) {
  test(`keeps provider child context compact on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(
      `${baseURL}/projects/${projectId}/sessions/${sessionId}/agents/${agentId}`,
    );

    const heading = page.getByRole("heading", {
      level: 1,
      name: "Inspect the provider child layout",
    });
    const header = heading.locator("xpath=ancestor::header");
    const readOnly = header.getByText(
      "Read-only. This subagent has no input channel.",
    );
    const parentLink = header.getByRole("link", {
      name: "Back to parent session",
    });

    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(readOnly).toBeVisible();
    await expect(parentLink).toBeVisible();
    await expect(
      page.getByText("The compact title layout keeps the transcript visible."),
    ).toBeVisible();

    const columns = await layoutColumns(header);
    const headingBox = await heading.boundingBox();
    const readOnlyBox = await readOnly.boundingBox();
    const parentLinkBox = await parentLink.boundingBox();
    if (!headingBox || !readOnlyBox || !parentLinkBox) {
      throw new Error("Provider child title context has no layout box");
    }

    if (viewport.name === "desktop") {
      expect(columns).toHaveLength(3);
      expect(readOnlyBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
      expect(parentLinkBox.x).toBeGreaterThan(
        readOnlyBox.x + readOnlyBox.width,
      );
    } else {
      expect(columns).toHaveLength(1);
      expect(readOnlyBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
      expect(parentLinkBox.y).toBeGreaterThan(
        readOnlyBox.y + readOnlyBox.height,
      );
    }

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    await capture(
      page,
      `provider-child-session-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });
}
