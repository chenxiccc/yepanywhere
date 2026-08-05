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

test("right click opens session share management without creating a link", async ({
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

  const indicator = page.locator("button.session-header-viewer-count");
  await expect(indicator).toBeVisible();
  const indicatorBox = await indicator.boundingBox();
  expect(indicatorBox).not.toBeNull();
  await indicator.click({ button: "right" });
  const dialog = page.getByRole("dialog");
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
    dialog.getByRole("button", { name: "Revoke All Shared Links" }),
  ).toBeEnabled();
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("2 matching public link(s)")).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox?.x).toBeLessThanOrEqual(indicatorBox?.x ?? 0);
  expect(dialogBox?.y).toBeGreaterThan(indicatorBox?.y ?? 0);

  const captureDirectory = process.env.YEP_PUBLIC_SHARE_CAPTURE_DIR;
  if (captureDirectory) {
    mkdirSync(captureDirectory, { recursive: true });
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

  await dialog.getByRole("button", { name: "All projects" }).click();
  await expect(
    dialog.getByRole("button", { name: "All projects" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Revoke Every Public Link" }),
  ).toBeEnabled();

  const inventory = await fetch(
    `${baseURL}/api/public-shares?projectId=${projectId}&sessionId=${sessionId}`,
  );
  expect(inventory.ok).toBe(true);
  expect((await inventory.json()).totalCount).toBe(2);

});
