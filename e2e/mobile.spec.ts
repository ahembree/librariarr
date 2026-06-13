import { test, expect } from "@playwright/test";

/**
 * Below the md breakpoint the shell swaps the permanent sidebar for a glass
 * header whose hamburger opens the navigation drawer. These run at a phone
 * viewport (storage state from the chromium project is retained).
 */
test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile navigation drawer", () => {
  test("hamburger opens the drawer and a link navigates", async ({ page }) => {
    await page.goto("/settings");

    const hamburger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    // The drawer is a dialog; scope link lookups to it to avoid matching
    // any library tiles rendered in the page body.
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    await drawer.getByRole("link", { name: /^Movies$/i }).click();
    await page.waitForURL(/\/library\/movies/);
    await expect(page).toHaveURL(/\/library\/movies/);
    // Navigating auto-closes the drawer.
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("mobile header shows the brand", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /open navigation menu/i })).toBeVisible();
    await expect(page.getByText("Librari").first()).toBeVisible();
  });
});
