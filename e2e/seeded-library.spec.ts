import { test, expect, type Page } from "@playwright/test";
import { seedMovieLibrary, cleanupSeed, dropAppCaches, SEED } from "./seed";

/**
 * Data-dependent views: with a real server + library + movie seeded directly
 * into the DB, the movie list, the table view, the detail page, and the
 * settings server list all render the populated state. Seeding is contained to
 * this file (seed before, clean up after) so every other spec keeps its empty DB.
 */
/** Ctrl+K, again until the palette opens: a press before hydration is lost. */
async function openPalette(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test.describe("populated library", () => {
  test.beforeAll(async () => {
    await seedMovieLibrary();
  });

  // The rows went in past the app, so a listing an earlier spec cached over the
  // empty database (the server keeps one for a minute) must go first.
  test.beforeEach(async ({ page }) => {
    await dropAppCaches(page.request);
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
    await openPalette(page);
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
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
    await page.getByRole("button", { name: /^Filters$/i }).click();
    await expect(page.getByText(/narrow down your library/i)).toBeVisible();

    // The Video Codec facet lists the seeded movie's codec.
    await page.getByPlaceholder("Search filters...").fill("Video Codec");
    await page.getByRole("button", { name: "Video Codec", exact: true }).click();
    await expect(page.getByRole("option", { name: "hevc", exact: true })).toBeVisible();
  });

  test("a query column scrolled under the pinned ones cannot be grabbed through them", async ({ page }) => {
    await page.goto("/library/query");
    await page.getByPlaceholder("Value").first().fill(SEED.movieTitle);
    await page.getByRole("button", { name: /Run Query/ }).click();
    await expect(page.locator("table tbody").getByText(SEED.movieTitle)).toBeVisible();
    await page.locator("table thead").scrollIntoViewIfNeeded();

    // Scroll the first unpinned column until its right edge, and the resize
    // handle on it, sits 12px inside the last pinned header.
    const probe = await page.evaluate(() => {
      const container = document.querySelector("table")!.parentElement!;
      const heads = [...document.querySelectorAll<HTMLElement>("table thead th")];
      const pinned = heads.filter((th) => getComputedStyle(th).position === "sticky");
      const firstUnpinned = heads[pinned.length];
      const wanted = Math.round(firstUnpinned.getBoundingClientRect().width + 12);
      container.scrollLeft = wanted;
      const lastPinned = pinned[pinned.length - 1].getBoundingClientRect();
      return {
        x: lastPinned.right - 14,
        y: lastPinned.top + lastPinned.height / 2,
        lastPinned: pinned[pinned.length - 1].textContent,
        wanted,
        scrolled: container.scrollLeft,
      };
    });
    // The table really scrolled that far — a scroll the browser clamped short
    // would leave nothing under the pinned header and prove nothing.
    expect(Math.abs(probe.scrolled - probe.wanted)).toBeLessThanOrEqual(1);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest("th")?.textContent ?? null,
      probe,
    );
    expect(hit).toBe(probe.lastPinned);
  });

  test("query criterion columns load only once the table view shows them", async ({ page }) => {
    await page.goto("/library/query");
    await page.evaluate(() => {
      localStorage.setItem("query-visible-columns", JSON.stringify(["type", "title", "year", "field:studio"]));
      localStorage.setItem("query-view-mode", "cards");
    });
    await page.reload();
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/query/column-values")) requests.push(r.url());
    });

    await page.getByPlaceholder("Value").first().fill(SEED.movieTitle);
    await page.getByRole("button", { name: /Run Query/ }).click();
    await expect(page.getByText(SEED.movieTitle).first()).toBeVisible();
    // An absence: give a request the card view should not make time to go out.
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(0);

    const loaded = page.waitForResponse((r) => r.url().includes("/api/query/column-values"));
    await page.getByRole("button", { name: "Table view" }).click();
    await loaded;
    expect(requests).toHaveLength(1);
  });

  test("settings lists the seeded media server", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Media Servers$/i }).click();
    // Scoped to the tab's panel: the shell's "… is unreachable" banner and
    // toast name the server too (its address listens nowhere).
    const panel = page.locator("#settings-panel-servers");
    await expect(panel.getByText(SEED.serverName).first()).toBeVisible();
    await expect(panel.getByText(/no media servers connected/i)).toHaveCount(0);
  });
});
