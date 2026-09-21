import { test, expect } from "@playwright/test";

test("case form exposes validation rather than a blank page", async ({ page }) => {
  await page.goto("/cases/new");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("#customer-question")).toBeVisible();
  await expect(page.locator("input[type=file]")).toHaveAttribute("accept", /image\/webp/);
  await expect(page.getByRole("button", { name: /运行规则|保存案件/ })).toBeDisabled();
});
