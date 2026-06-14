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

  test("the command palette finds the seeded movie and navigates to it", async ({ page }) => {
    await page.goto("/library/movies");
    await page.keyboard.press("Control+k");
    await page
      .getByPlaceholder(/search movies, series, artists, albums/i)
      .fill("E2E Seed");

    const result = page.getByRole("dialog").getByText(SEED.movieTitle);
    await expect(result).toBeVisible();
    await result.click();

    await page.waitForURL(new RegExp(`/library/movies/${SEED.movieId}`));
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
  });

  test("the title search filters the seeded movie out of the list", async ({ page }) => {
    await page.goto("/library/movies");
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();

    const search = page.getByPlaceholder("Search titles...");
    await search.fill("zzz-no-such-title");
    await search.press("Enter");

    // The server-side title filter excludes the seeded movie, leaving the
    // filtered empty state in its place.
    await expect(page.getByText("No movies found.")).toBeVisible();
    await expect(page.getByText(SEED.movieTitle)).toHaveCount(0);

    // Emptying the search box restores the full list.
    await search.fill("");
    await search.press("Enter");
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
  });

  test("the filters panel opens with the seeded library's facets", async ({ page }) => {
    await page.goto("/library/movies");
    await page.getByRole("button", { name: /^Filters$/i }).click();
    await expect(page.getByText(/narrow down your library/i)).toBeVisible();
  });

  test("settings lists the seeded media server", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Media Servers$/i }).click();
    await expect(page.getByText(SEED.serverName).first()).toBeVisible();
    await expect(page.getByText(/no media servers connected/i)).toHaveCount(0);
  });
});
