import { expect, test } from "./fixtures.js";

test("selecting a settings category clears the search", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${baseURL}/settings`);

  const skipOnboarding = page.locator(".onboarding-skip-all");
  if (await skipOnboarding.isVisible()) {
    await skipOnboarding.click();
  }

  const search = page.getByRole("searchbox", { name: "Search settings" });
  await expect(search).toBeVisible();
  await search.fill("theme");
  await expect(search).toHaveValue("theme");

  await page
    .locator(".settings-category-nav")
    .getByRole("button", { name: /Speech backends/ })
    .click();

  await expect(page).toHaveURL(/\/settings\/speech$/);
  await expect(search).toHaveValue("");
});
