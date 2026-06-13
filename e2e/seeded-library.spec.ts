import { test, expect } from "@playwright/test";
import { seedMovieLibrary, cleanupSeed, SEED } from "./seed";

/**
 * Data-dependent views: with a real server + library + movie seeded directly
 * into the DB, the movie list, the table view, the detail page, and the
 * settings server list all render the populated state. Seeding is contained to
 * this file (seed before, clean up after) so every other spec keeps its empty DB.
 */
test.describe("populated library", () => {
  test.beforeAll(async () => {
    await seedMovieLibrary();
  });

  test.afterAll(async () => {
    await cleanupSeed();
  });

  test("movies list shows the seeded movie instead of the empty state", async ({ page }) => {
    await page.goto("/library/movies");
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
    await expect(page.getByText("No movies found.")).toHaveCount(0);
  });

  test("table view also renders the seeded movie", async ({ page }) => {
    await page.goto("/library/movies");
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
  });

  test("the movie detail page renders the seeded title", async ({ page }) => {
    await page.goto(`/library/movies/${SEED.movieId}`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
  });

  test("settings lists the seeded media server", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Media Servers$/i }).click();
    await expect(page.getByText(SEED.serverName).first()).toBeVisible();
    await expect(page.getByText(/no media servers connected/i)).toHaveCount(0);
  });
});
