import { test, expect } from "@playwright/test";

/**
 * Lifecycle rules page renders and exposes the rule-builder entry point.
 */
test.describe("lifecycle", () => {
  test("rules page renders with the media-type tabs", async ({ page }) => {
    await page.goto("/lifecycle/rules");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /rules/i }).first()).toBeVisible();
    // The unified rules page has Movies / Series / Music tabs.
    await expect(page.getByText(/movies/i).first()).toBeVisible();
  });

  test("matches, pending and exceptions pages render", async ({ page }) => {
    for (const path of ["/lifecycle/matches", "/lifecycle/pending", "/lifecycle/exceptions"]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });
});
