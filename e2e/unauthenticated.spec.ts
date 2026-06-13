import { test, expect } from "@playwright/test";

/**
 * Unauthenticated journeys (run with a cleared storage state). The admin still
 * exists in the DB (created by auth.setup), so the login page is past first-run.
 */
const GUARDED = [
  "/",
  "/settings",
  "/library/movies",
  "/library/series",
  "/library/music",
  "/library/history",
  "/library/query",
  "/lifecycle/rules",
  "/lifecycle/matches",
  "/lifecycle/pending",
  "/lifecycle/exceptions",
  "/tools/streams",
  "/tools/preroll",
  "/system/logs",
];

test.describe("auth guard & login page", () => {
  for (const path of GUARDED) {
    test(`redirects ${path} to /login when unauthenticated`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test("login page renders the welcome card and a sign-in method", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/welcome to librariarr/i)).toBeVisible();

    // Either the Plex button or the local username/password form must be present.
    const plex = page.getByRole("button", { name: /sign in with plex/i });
    const localUser = page.locator("#username");
    await expect(plex.or(localUser).first()).toBeVisible();
  });

  test("local sign-in form is available after first-run", async ({ page }) => {
    await page.goto("/login");
    // Local auth was enabled by the setup flow, so the form should render.
    await expect(page.locator("#username")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  });
});
