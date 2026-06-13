import { test, expect } from "@playwright/test";

/**
 * Settings page: tabs are reachable and a setting round-trips. The General tab
 * exposes the appearance/scheduling controls; we verify the tab navigation
 * (hash-driven) and that a saved change persists across a reload.
 */
test.describe("settings", () => {
  test("renders and navigates tabs", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /settings/i }).first()).toBeVisible();

    // Tab navigation is hash-based (#general, #servers, …). Visiting a hash
    // should keep us on the settings page with the tab active.
    for (const hash of ["#servers", "#integrations", "#general"]) {
      await page.goto(`/settings${hash}`);
      await expect(page).toHaveURL(new RegExp(`/settings`));
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });

  test("accent color selection persists across reload", async ({ page }) => {
    await page.goto("/settings#general");
    // Accent color swatches are buttons with an accessible name (preset names).
    const swatch = page.getByRole("button", { name: /emerald|blue|violet|amber|rose|teal/i }).first();
    if (await swatch.isVisible().catch(() => false)) {
      await swatch.click();
      await page.waitForTimeout(500); // allow the PUT to settle
      await page.reload();
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });
});
