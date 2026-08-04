import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

const captureDir = process.env.TOOLTIP_CAPTURE_DIR;

async function installTooltipFixture(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-tooltip-mode", "themed");
    localStorage.setItem("yep-anywhere-tooltip-delay-ms", "50");
  });
  await page.goto(baseURL);
  await page.locator("#root").waitFor({ state: "attached" });
  await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "tooltip-noninterference-fixture";
    Object.assign(fixture.style, {
      position: "fixed",
      zIndex: "2147483000",
      top: "64px",
      left: "16px",
      width: "min(620px, calc(100vw - 32px))",
      minHeight: "620px",
      boxSizing: "border-box",
      padding: "20px",
      border: "1px solid var(--border-color)",
      borderRadius: "10px",
      background: "var(--bg-primary)",
      color: "var(--text-primary)",
      fontFamily: "var(--font-ui)",
    });
    fixture.innerHTML = `
      <h1 style="margin:0 0 8px;font-size:20px">Tooltip interaction fixture</h1>
      <p style="margin:0 0 18px;color:var(--text-secondary)">
        Passive hints preserve their hover region without owning clicks.
      </p>
      <button id="own-trigger" type="button"
        title="Open the intended card action"
        style="display:block;width:260px;height:52px">
        Intended card action
      </button>
      <output id="own-count" style="display:block;margin:6px 0 20px">own: 0</output>
      <div style="position:relative;height:92px">
        <button id="small-trigger" type="button"
          title="A tooltip covering an unrelated control"
          style="position:absolute;left:0;top:0;width:36px;height:36px">?</button>
        <button id="covered-control" type="button"
          style="position:absolute;left:42px;top:8px;width:260px;height:48px">
          Unrelated covered control
        </button>
      </div>
      <output id="covered-count" style="display:block;margin:-20px 0 20px">
        covered: 0
      </output>
      <button id="long-trigger" type="button" style="display:block;width:260px;height:52px">
        Long scrollable hint
      </button>
      <output id="scroll-status" style="display:block;margin-top:8px">scroll: 0</output>
    `;
    document.body.append(fixture);

    let ownCount = 0;
    let coveredCount = 0;
    const own = fixture.querySelector<HTMLButtonElement>("#own-trigger");
    const covered =
      fixture.querySelector<HTMLButtonElement>("#covered-control");
    const long = fixture.querySelector<HTMLButtonElement>("#long-trigger");
    if (!own || !covered || !long) throw new Error("invalid tooltip fixture");
    own.addEventListener("click", () => {
      ownCount += 1;
      const output = fixture.querySelector("#own-count");
      if (output) output.textContent = `own: ${ownCount}`;
    });
    covered.addEventListener("click", () => {
      coveredCount += 1;
      const output = fixture.querySelector("#covered-count");
      if (output) output.textContent = `covered: ${coveredCount}`;
    });
    long.title = Array.from(
      { length: 80 },
      (_, index) =>
        `Line ${String(index + 1).padStart(2, "0")} — stable wrapping while the tooltip scrolls`,
    ).join("\n");
  });
}

function intersectionPoint(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) {
    throw new Error("fixture tooltip does not overlap its expected control");
  }
  return { x: left + 2, y: top + 2 };
}

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`passive tooltips preserve activation and scrolling at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await installTooltipFixture(page, baseURL);
    const tooltip = page.locator("#ya-global-tooltip");

    const own = page.locator("#own-trigger");
    await own.hover({ position: { x: 20, y: 20 } });
    await expect(tooltip).toHaveText("Open the intended card action");
    const ownBox = await own.boundingBox();
    const ownTooltipBox = await tooltip.boundingBox();
    if (!ownBox || !ownTooltipBox) throw new Error("missing own tooltip box");
    const ownPoint = intersectionPoint(ownBox, ownTooltipBox);
    await page.mouse.click(ownPoint.x, ownPoint.y);
    await expect(page.locator("#own-count")).toHaveText("own: 1");

    await page.mouse.move(4, 4);
    const small = page.locator("#small-trigger");
    await small.hover({ position: { x: 12, y: 12 } });
    await expect(tooltip).toHaveText(
      "A tooltip covering an unrelated control",
    );
    const covered = page.locator("#covered-control");
    const coveredBox = await covered.boundingBox();
    const coveredTooltipBox = await tooltip.boundingBox();
    if (!coveredBox || !coveredTooltipBox) {
      throw new Error("missing covered tooltip box");
    }
    const coveredPoint = intersectionPoint(coveredBox, coveredTooltipBox);
    await page.mouse.click(coveredPoint.x, coveredPoint.y);
    await expect(page.locator("#covered-count")).toHaveText("covered: 0");

    await page.mouse.move(4, 4);
    const long = page.locator("#long-trigger");
    await long.hover({ position: { x: 20, y: 20 } });
    await expect(tooltip).toContainText("Line 80");
    await expect(tooltip).toBeVisible();
    const beforeScrollBox = await tooltip.boundingBox();
    if (!beforeScrollBox) throw new Error("missing scroll tooltip box");
    const scrollPoint = {
      x: beforeScrollBox.x + Math.min(24, beforeScrollBox.width / 2),
      y: beforeScrollBox.y + Math.min(24, beforeScrollBox.height / 2),
    };
    await page.mouse.move(scrollPoint.x, scrollPoint.y);
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 280);
    await expect
      .poll(() => tooltip.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const scrollTop = await tooltip.evaluate((element) => element.scrollTop);
    await page.locator("#scroll-status").evaluate((output, value) => {
      output.textContent = `scroll: ${value}`;
    }, Math.round(scrollTop));
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    expect(await tooltip.boundingBox()).toEqual(beforeScrollBox);

    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await page.screenshot({
        path: join(captureDir, `${viewport.name}.png`),
        fullPage: false,
      });
    }

    const compactFontSize = await tooltip.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    await page.mouse.click(scrollPoint.x, scrollPoint.y, {
      button: "right",
    });
    const enlargedFontSize = await tooltip.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(enlargedFontSize).toBeGreaterThan(compactFontSize);
    const enlargedBox = await tooltip.boundingBox();
    if (!enlargedBox) throw new Error("missing enlarged tooltip box");
    const expectedLeft = Math.min(
      viewport.width - 8 - enlargedBox.width,
      Math.max(8, beforeScrollBox.x),
    );
    const expectedTop = Math.min(
      viewport.height - 8 - enlargedBox.height,
      Math.max(8, beforeScrollBox.y),
    );
    expect(enlargedBox.x).toBeCloseTo(expectedLeft, 0);
    expect(enlargedBox.y).toBeCloseTo(expectedTop, 0);
    const compactAspect = beforeScrollBox.width / beforeScrollBox.height;
    const enlargedAspect = enlargedBox.width / enlargedBox.height;
    expect(enlargedAspect / compactAspect).toBeGreaterThan(0.8);
    expect(enlargedAspect / compactAspect).toBeLessThan(1.25);
  });
}
