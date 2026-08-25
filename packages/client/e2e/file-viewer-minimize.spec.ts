import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "file-viewer-absolute-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.locator(".onboarding-skip-all");
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

async function capture(page: Page, name: string) {
  const artifactDir = process.env.YEP_UI_CAPTURE_DIR;
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDir, `${name}.png`),
  });
}

test("keeps the viewer open while transcript rich text settles", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);

  const absoluteLink = page.locator(
    'a[data-ya-private-project-file-link="true"]',
  );
  await expect(absoluteLink).toBeVisible({ timeout: 10000 });
  await absoluteLink.click();

  const viewer = page.locator(".file-viewer");
  await expect(viewer).toBeVisible();
  await page.waitForTimeout(750);
  await expect(viewer).toBeVisible();
  await capture(page, "desktop-1000-rich-text-replacement");
});

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "desktop-1024", width: 1024, height: 768 },
  { name: "tablet-800", width: 800, height: 900 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`minimizes and restores an external file viewer at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    const glossaryRequests: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/glossary-artifact")) {
        glossaryRequests.push(url);
      }
    });

    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const absoluteLink = page.locator(
      'a[data-ya-private-project-file-link="true"]',
    );
    await expect(absoluteLink).toBeVisible({ timeout: 10000 });
    await dismissOnboardingIfVisible(page);
    // Let the initial transcript's rich-text replacement settle so this loop
    // isolates viewer presentation; the preceding regression covers
    // replacement while the viewer is already open.
    await page.waitForTimeout(750);
    await absoluteLink.click();

    const viewer = page.locator(".file-viewer");
    await expect(viewer).toBeVisible();
    if (viewport.width <= 800) {
      const [modalBox, composerBox] = await Promise.all([
        page.locator(".file-viewer-modal").boundingBox(),
        page.locator(".session-input").boundingBox(),
      ]);
      expect(modalBox?.x).toBe(0);
      expect(modalBox?.width).toBe(viewport.width);
      if (!modalBox || !composerBox) {
        throw new Error("Expected viewer and composer layout boxes");
      }
      expect(
        Math.abs(modalBox.y + modalBox.height - composerBox.y),
      ).toBeLessThan(1.1);
    }
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.locator('[data-glossary-term="true"]', {
        hasText: "Viewer context",
      }),
    ).toBeVisible();
    await expect.poll(() => glossaryRequests.length).toBeGreaterThan(0);
    expect(glossaryRequests.at(-1)?.searchParams.has("sourcePath")).toBe(false);

    const controller = page.getByRole("group", { name: /File viewer:/ });
    await expect(controller).toBeVisible();
    await expect(controller).toContainText("README.md");
    const [leftControlsBox, controllerBox] = await Promise.all([
      page.locator(".message-input-left").boundingBox(),
      controller.boundingBox(),
    ]);
    if (!leftControlsBox || !controllerBox) {
      throw new Error("Expected toolbar controls to have layout boxes");
    }
    expect(controllerBox.x).toBeGreaterThanOrEqual(
      leftControlsBox.x + leftControlsBox.width,
    );
    await expect(
      controller.getByRole("button", { name: /Minimize file viewer:/ }),
    ).toBeVisible();
    if (viewport.width <= 800) {
      await expect(
        page.locator(".message-input-toolbar .voice-input-button"),
      ).toBeVisible();
      await expect(
        page.locator(".message-input-toolbar .send-button-with-help"),
      ).toBeVisible();
    }

    await capture(page, `${viewport.name}-open`);
    if (viewport.name === "desktop") {
      const modeButton = page.locator(".message-input-toolbar .mode-button");
      await expect(modeButton).toBeVisible();
      const modeButtonBox = await modeButton.boundingBox();
      if (!modeButtonBox) {
        throw new Error("Expected permission mode button to have a layout box");
      }
      const modeButtonIsHitTarget = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest(".message-input-toolbar .mode-button") !== null,
        {
          x: modeButtonBox.x + modeButtonBox.width / 2,
          y: modeButtonBox.y + modeButtonBox.height / 2,
        },
      );
      expect(modeButtonIsHitTarget).toBe(true);
      await page.mouse.click(
        modeButtonBox.x + modeButtonBox.width / 2,
        modeButtonBox.y + modeButtonBox.height / 2,
      );
      await expect(viewer).not.toBeVisible();
      await expect(controller).toBeVisible();
      await expect(page.locator(".mode-selector-dropdown")).toBeVisible();
      await capture(page, "desktop-toolbar-action-parked");
      await page.keyboard.press("Escape");
      await controller
        .getByRole("button", { name: /Restore file viewer:/ })
        .click();
      await expect(viewer).toBeVisible();
    } else {
      const conversationButton = page.locator(
        ".message-input-toolbar .conversation-view-toolbar-button",
      );
      await expect(conversationButton).toBeVisible();
      const conversationButtonBox = await conversationButton.boundingBox();
      if (!conversationButtonBox) {
        throw new Error("Expected conversation button to have a layout box");
      }
      const conversationButtonIsHitTarget = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest(
              ".message-input-toolbar .conversation-view-toolbar-button",
            ) !== null,
        {
          x: conversationButtonBox.x + conversationButtonBox.width / 2,
          y: conversationButtonBox.y + conversationButtonBox.height / 2,
        },
      );
      expect(conversationButtonIsHitTarget).toBe(true);
      const pressedBefore =
        await conversationButton.getAttribute("aria-pressed");
      await page.mouse.click(
        conversationButtonBox.x + conversationButtonBox.width / 2,
        conversationButtonBox.y + conversationButtonBox.height / 2,
      );
      await expect(viewer).not.toBeVisible();
      await expect(controller).toBeVisible();
      await expect(conversationButton).toHaveAttribute(
        "aria-pressed",
        pressedBefore === "true" ? "false" : "true",
      );
      await controller
        .getByRole("button", { name: /Restore file viewer:/ })
        .click();
      await expect(viewer).toBeVisible();
    }
    if (viewport.width <= 800) {
      const viewerBody = viewer.locator(".file-viewer-body");
      const finalLine = viewer.getByText(
        "End of file viewer clearance specimen.",
        { exact: true },
      );
      await viewerBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(finalLine).toBeVisible();
      const [finalLineBox, toolbarBox] = await Promise.all([
        finalLine.boundingBox(),
        page.locator(".message-input-toolbar").boundingBox(),
      ]);
      if (!finalLineBox || !toolbarBox) {
        throw new Error("Expected final line and toolbar to have layout boxes");
      }
      expect(finalLineBox.y + finalLineBox.height).toBeLessThanOrEqual(
        toolbarBox.y,
      );
      await capture(page, `${viewport.name}-scrolled-bottom`);
    }
    await viewer.getByRole("button", { name: "Minimize file viewer" }).click();
    await expect(viewer).not.toBeVisible();

    const restore = controller.getByRole("button", {
      name: /Restore file viewer:/,
    });
    await expect(restore).toBeVisible();
    expect((await controller.boundingBox())?.width).toBeGreaterThanOrEqual(
      viewport.name === "mobile" ? 148 : 60,
    );
    expect(
      await controller.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toContain("file-viewer-arrive");
    await capture(page, `${viewport.name}-parked`);

    await restore.click();
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();

    await controller
      .getByRole("button", { name: /Minimize file viewer:/ })
      .click();
    await expect(viewer).not.toBeVisible();
    await controller
      .getByRole("button", { name: /Close file viewer:/ })
      .click();
    await expect(controller).not.toBeVisible();
  });
}
