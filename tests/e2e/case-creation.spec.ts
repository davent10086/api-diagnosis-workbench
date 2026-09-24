import { test, expect } from "@playwright/test";

test("case form exposes validation rather than a blank page", async ({ page }) => {
  await page.goto("/cases/new");
  await expect(page.getByRole("main").first()).toBeVisible();
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.locator("input[type=file]").first()).toHaveAttribute("accept", /image\/png/);
  await expect(page.locator("button.btn-primary").first()).toBeVisible();
});

test("sidebar stays mounted while navigating between pages", async ({ page }) => {
  await page.goto("/cases");
  await page.locator("aside").evaluate((element) => { element.dataset.navigationMarker = "retained"; });
  for (const route of ["/knowledge", "/quality", "/cases"]) {
    await page.locator(`nav a[href="${route}"]`).click();
    await page.waitForURL(`**${route}`);
    await expect(page.locator("aside")).toHaveAttribute("data-navigation-marker", "retained");
    await expect(page.getByRole("main")).toHaveCount(1);
  }
});
