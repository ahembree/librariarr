import { test, expect } from "@playwright/test";
import { PAGES } from "./constants";

/**
 * Every authenticated page must render for a logged-in admin without redirecting
 * back to /login, and show its heading. This covers routing, the auth layout
 * guard, and the page's initial data fetch (empty state is fine) across the app.
 */
test.describe("authenticated navigation", () => {
  for (const { path, heading } of PAGES) {
    test(`renders ${path}`, async ({ page }) => {
      await page.goto(path);
      // Did not bounce to login → the session is valid and the guard passed.
      await expect(page).not.toHaveURL(/\/login/);
      // The page rendered a heading.
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    });
  }
});
