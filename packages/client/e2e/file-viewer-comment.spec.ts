import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
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

async function openRenderedMarkdown(page: Page) {
  await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const sourceLink = page.locator(
    'a[data-ya-private-project-file-link="true"]',
  );
  await expect(sourceLink).toBeVisible();
  await dismissOnboardingIfVisible(page);
  await page.waitForTimeout(750);
  await sourceLink.click();
  const preview = page.locator(".file-viewer-modal .markdown-preview");
  await expect(preview).toBeVisible();
  return preview;
}

async function textPoint(locator: Locator, horizontal: "start" | "end") {
  return locator.evaluate((element, edge) => {
    const text = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null;
    if (!text) throw new Error("Expected rendered Markdown text");
    const range = document.createRange();
    const offset = edge === "start" ? 0 : text.data.length;
    range.setStart(text, offset);
    range.setEnd(text, offset);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, horizontal);
}

async function quoteButtonForBlock(buttons: Locator, block: Locator) {
  const blockBox = await block.boundingBox();
  if (!blockBox) throw new Error("Expected rendered Markdown block");
  const blockBottom = blockBox.y + blockBox.height;
  let nearest: { distance: number; locator: Locator } | undefined;
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const locator = buttons.nth(index);
    const box = await locator.boundingBox();
    if (!box) continue;
    const distance = Math.abs(box.y + box.height / 2 - blockBottom);
    if (!nearest || distance < nearest.distance) {
      nearest = { distance, locator };
    }
  }
  if (!nearest) throw new Error("Expected a visible paragraph quote button");
  return nearest.locator;
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

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`keeps rendered clicks native and quotes from circles at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const preview = await openRenderedMarkdown(page);
    const viewerBody = page.locator(".file-viewer-modal .file-viewer-body");
    const paragraph = preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    );
    await paragraph.click();

    const composer = page.locator("[data-composer-input]");
    await expect(composer).toHaveValue("");
    await expect(viewerBody).toBeFocused();

    const keyboardScrollStart = await viewerBody.evaluate(
      (element) => element.scrollTop,
    );
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => viewerBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(keyboardScrollStart);
    const wheelScrollStart = await viewerBody.evaluate(
      (element) => element.scrollTop,
    );
    const wheelScrollTarget = await viewerBody.evaluate(
      (element, delta) =>
        Math.min(
          element.scrollHeight - element.clientHeight,
          element.scrollTop + delta,
        ),
      300,
    );
    const viewerBox = await viewerBody.boundingBox();
    if (!viewerBox) throw new Error("Expected file viewer scroll owner");
    await page.mouse.move(
      viewerBox.x + viewerBox.width / 2,
      viewerBox.y + viewerBox.height / 2,
    );
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => viewerBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(wheelScrollTarget - 1);
    expect(wheelScrollTarget).toBeGreaterThan(wheelScrollStart);
    await viewerBody.evaluate((element) => {
      element.scrollTop = 0;
    });

    await paragraph.hover();
    const quoteButtons = page.getByRole("button", {
      name: /Quote this paragraph/,
    });
    const quoteButton = await quoteButtonForBlock(quoteButtons, paragraph);
    await expect(quoteButton).toBeVisible();
    await quoteButton.click();
    await expect(composer).toHaveValue(
      "> Viewer context remains available while reviewing this file.\n",
    );
    await expect(composer).toBeFocused();
    await expect(page.locator(".file-viewer-modal")).toBeVisible();

    const [modalBox, composerBox] = await Promise.all([
      page.locator(".file-viewer-modal").boundingBox(),
      page.locator(".session-input").boundingBox(),
    ]);
    if (!modalBox || !composerBox) {
      throw new Error("Expected viewer and composer layout boxes");
    }
    expect(Math.abs(modalBox.y + modalBox.height - composerBox.y)).toBeLessThan(
      1.1,
    );
    await capture(page, `${viewport.name}-markdown-quote`);
  });

  test(`opens an inline selection comment without consuming the composer at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-selection-text-copy-action-enabled",
        "true",
      );
    });
    const sentMessages: string[] = [];
    await page.route("**/resume", async (route) => {
      const request = route.request().postDataJSON() as { message?: string };
      if (request.message) sentMessages.push(request.message);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          processId: "file-comment-e2e",
          permissionMode: "default",
          modeVersion: 1,
          serverTimestamp: Date.now(),
        }),
      });
    });
    const preview = await openRenderedMarkdown(page);
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Main composer draft stays put.");
    const viewer = page.locator(".file-viewer-modal");
    const commentToggle = viewer.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await expect(commentToggle).toHaveAttribute("aria-pressed", "false");
    await commentToggle.click();
    await expect(commentToggle).toHaveAttribute("aria-pressed", "true");

    const paragraph = preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    );
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const editor = viewer.getByPlaceholder("Comment or ask a question…");
    await expect(editor).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy text" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quote reply" })).toHaveCount(
      0,
    );
    await expect(
      viewer.getByRole("button", { name: /Quote this paragraph/ }),
    ).toHaveCount(0);
    await editor.focus();
    await expect(editor).toBeVisible();
    await editor.fill("Question on this passage?");
    await expect(editor).toBeVisible();
    await editor.press("Shift+Enter");
    await editor.pressSequentially("Please check it.");
    await expect(editor).toHaveValue(
      "Question on this passage?\nPlease check it.",
    );
    await capture(page, `${viewport.name}-markdown-comment`);

    await editor.press("Enter");
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("README.md:5");
    expect(sentMessages[0]).toContain(
      "> Viewer context remains available while reviewing this file.",
    );
    expect(sentMessages[0]).toContain(
      "Question on this passage?\nPlease check it.",
    );
    await expect(composer).toHaveValue("Main composer draft stays put.");
  });
}

test("opens the viewer toolbar link with a native middle click", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openRenderedMarkdown(page);
  const openLink = page
    .locator(".file-viewer-modal")
    .getByRole("link", { name: "Open in new tab" });
  await expect(openLink).toHaveAttribute("target", "_blank");

  const [openedPage] = await Promise.all([
    context.waitForEvent("page"),
    openLink.click({ button: "middle" }),
  ]);
  await expect(openedPage).toHaveURL(/\/file\?path=/);
  await openedPage.close();
  await expect(page.locator(".file-viewer-modal")).toBeVisible();
});

test("keeps selection actions out of an upward pointer drag", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  const preview = await openRenderedMarkdown(page);
  const start = await textPoint(
    preview.getByRole("heading", { name: "Scroll clearance specimen" }),
    "end",
  );
  const end = await textPoint(
    preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    ),
    "start",
  );

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.isCollapsed))
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "Quote reply" }),
  ).not.toBeVisible();

  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Quote reply" })).toBeVisible();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");
});
