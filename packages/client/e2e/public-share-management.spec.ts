import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configureRemoteAccess, e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

async function putJson(baseURL: string, pathname: string, body: unknown) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PUT ${pathname} failed: ${await response.text()}`);
  }
}

async function postJson(baseURL: string, pathname: string, body: unknown) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathname} failed: ${await response.text()}`);
  }
  return response;
}

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

test("left and right click open the same share manager", async ({
  page,
  baseURL,
}) => {
  await configureRemoteAccess(baseURL, {
    username: "public-share-e2e",
    password: "public-share-password-123",
    relayUrl: "ws://127.0.0.1:9/ws",
  });
  await putJson(baseURL, "/api/settings", { publicSharesEnabled: true });
  for (const mode of ["frozen", "live"] as const) {
    await postJson(baseURL, "/api/public-shares", {
      projectId,
      sessionId,
      mode,
      title: mode === "frozen" ? "Release snapshot" : "Live review",
    });
  }
  await page.route("**/api/public-shares/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, canCreate: false } });
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await expect(
    page.getByRole("main").getByText("Previous message"),
  ).toBeVisible({
    timeout: 10000,
  });
  const version = await (await fetch(`${baseURL}/api/version`)).json();
  expect(version.capabilities).toContain("public-share-management");
  await page.waitForTimeout(500);

  await page
    .locator("header.session-header")
    .getByLabel("Session options")
    .click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Create and copy/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const indicator = page.locator("button.session-header-viewer-count");
  await expect(indicator).toBeVisible();
  const indicatorBox = await indicator.boundingBox();
  expect(indicatorBox).not.toBeNull();
  await indicator.click({ button: "right" });
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "This session", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Read-only", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Live", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Share This Session" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Review all Read-only share links in This session for revocation",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Review all Live share links in This session for revocation",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Review all share links in This project for revocation",
    }),
  ).toBeEnabled();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("img", { name: "Live" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Read-only" })).toBeVisible();
  await expect(page.getByText("2 matching public link(s)")).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox?.x).toBeLessThanOrEqual(indicatorBox?.x ?? 0);
  expect(dialogBox?.y).toBeGreaterThan(indicatorBox?.y ?? 0);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await indicator.click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "This session", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  const captureDirectory = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  await dialog
    .getByRole("button", {
      name: "Review all Read-only share links in This session for revocation",
    })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Confirm: revoke 1 Read-only share link(s) in This session (0 active client(s))",
    }),
  ).toBeEnabled();
  await expect(
    dialog.getByText(
      "Click again to revoke 1 Read-only share link(s) in This session (0 active client(s)). Anyone using one will immediately lose access.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /Click again to revoke 1 Read-only/,
    }),
  ).toHaveCount(0);
  if (captureDirectory) {
    mkdirSync(captureDirectory, { recursive: true });
    await page.screenshot({
      path: join(captureDirectory, "desktop-confirm-1920x1080.png"),
    });
  }

  await dialog.getByRole("button", { name: "Live", exact: true }).click();
  await expect(dialog.getByText(/Click again to revoke/)).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(2);

  if (captureDirectory) {
    await page.screenshot({
      path: join(captureDirectory, "desktop-1920x1080.png"),
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(dialog.getByRole("listitem")).toHaveCount(2);
    const mobileDialogBox = await dialog.boundingBox();
    const mobileIndicatorBox = await indicator.boundingBox();
    expect(mobileDialogBox).not.toBeNull();
    expect(mobileIndicatorBox).not.toBeNull();
    expect(mobileDialogBox?.x).toBeLessThanOrEqual(9);
    expect(mobileDialogBox?.width).toBeGreaterThanOrEqual(358);
    expect(mobileDialogBox?.y).toBeGreaterThan(mobileIndicatorBox?.y ?? 0);
    expect(mobileDialogBox?.y).toBeLessThan(100);
    await page.screenshot({
      path: join(captureDirectory, "mobile-375x812.png"),
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      localStorage.setItem("yep-anywhere-theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.screenshot({
      path: join(captureDirectory, "desktop-dark-1920x1080.png"),
    });
  }

  await dialog
    .getByRole("button", { name: "All projects", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "All projects", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", {
      name: "Review all Live share links in All projects for revocation",
    }),
  ).toBeEnabled();

  const inventory = await fetch(
    `${baseURL}/api/public-shares?projectId=${projectId}&sessionId=${sessionId}`,
  );
  expect(inventory.ok).toBe(true);
  expect((await inventory.json()).totalCount).toBe(2);

  const finalIndicatorBox = await indicator.boundingBox();
  expect(finalIndicatorBox).not.toBeNull();
  if (finalIndicatorBox) {
    await page.mouse.click(
      finalIndicatorBox.x + finalIndicatorBox.width / 2,
      finalIndicatorBox.y + finalIndicatorBox.height / 2,
    );
  }
  await expect(dialog).not.toBeVisible();

  await page.goto(`${baseURL}/sessions`);
  const sessionRow = page
    .getByRole("main")
    .locator("li.session-list-item")
    .filter({ hasText: "Previous message" })
    .first();
  await expect(sessionRow).toBeVisible();
  await sessionRow.getByLabel("Session options").click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "This session", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("Public Read-Only Share")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`${baseURL}/settings/remote`);
  await page.getByRole("button", { name: "Manage Links" }).click();
  await expect(dialog.getByText("Manage Public Shares")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Create and copy/ }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Show" })).toHaveCount(0);
});
