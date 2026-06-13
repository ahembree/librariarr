import { test, expect } from "@playwright/test";

/**
 * Unauthenticated journeys (run with a cleared storage state). The admin still
 * exists in the DB (created by auth.setup), so the login page is past first-run.
 */
test.describe("auth guard & login page", () => {
  test("redirects protected routes to /login when unauthenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/lifecycle/rules");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login page offers a sign-in method", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    // Either the Plex button or the local username/password form must be present.
    const plex = page.getByRole("button", { name: /sign in with plex/i });
    const localUser = page.locator("#username");
    await expect(plex.or(localUser).first()).toBeVisible();
  });
});
