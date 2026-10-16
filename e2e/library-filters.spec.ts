import { test, expect, type Page } from "@playwright/test";

/**
 * Library pages and the filters they offer.
 *
 * - The Series page sends its filters to `/api/media/series/grouped` and lists
 *   what the route answers. It used to send none and filter only resolution,
 *   dates and the title search on the client, so every other filter in the
 *   panel showed an active chip over an unfiltered list.
 * - The show-level filters (Episode Count, Watched %, …) are offered only on
 *   the Series tab, and the track-count filters only on Movies — the only
 *   listings that read them. Elsewhere they were chips that filtered nothing.
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

function show(parentTitle: string, seriesKey: string) {
  return {
    parentTitle,
    seriesKey,
    mediaItemId: `mi-${seriesKey}`,
    episodeCount: 10,
    seasonCount: 1,
    totalSize: "0",
    lastPlayed: null,
    addedAt: null,
    qualityCounts: { "1080P": 10 },
    servers: [],
    summary: null,
    genres: null,
    year: 2008,
  };
}

/** Opens the filter panel and searches it for `label`. */
async function searchFilterPanel(page: Page, label: string) {
  // A click that lands before the page hydrates opens nothing; click again.
  await expect(async () => {
    if (!(await page.getByText(/narrow down your library/i).isVisible())) {
      await page.getByRole("button", { name: /^Filters/ }).click();
    }
    await expect(page.getByText(/narrow down your library/i)).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.getByPlaceholder("Search filters...").fill(label);
}

test.describe("library — Series page filters", () => {
  test("sends the title search to the server and lists what it returns", async ({ page }) => {
    await page.route(isPath("/api/media/series/grouped"), (route) => {
      const search = new URL(route.request().url()).searchParams.get("search");
      return route.fulfill({
        json: {
          // The route's answer for the search, whatever its titles say: the
          // page must list it as given rather than filter it again.
          series: search ? [show("Server Answer", "tvdb:1")] : [show("Unfiltered One", "tvdb:2"), show("Unfiltered Two", "tvdb:3")],
          pagination: { page: 1, limit: 0, hasMore: false },
        },
      });
    });

    await page.goto("/library/series");
    await expect(page.getByText("Unfiltered One").first()).toBeVisible();

    const filtered = page.waitForRequest((req) => {
      const url = new URL(req.url());
      return url.pathname === "/api/media/series/grouped" && url.searchParams.get("search") === "breaking";
    });
    await page.getByPlaceholder("Search titles...").fill("breaking");
    await filtered;

    await expect(page.getByText("Server Answer").first()).toBeVisible();
    await expect(page.getByText("Unfiltered One")).toHaveCount(0);
  });
});

test.describe("library — filters each listing offers", () => {
  test("the show-level filters are offered on the Series tab only", async ({ page }) => {
    await page.goto("/library/series");
    await searchFilterPanel(page, "Episode Count");
    await expect(page.getByText("Episode Count", { exact: true })).toBeVisible();

    for (const path of ["/library/series/seasons", "/library/series/episodes"]) {
      await page.goto(path);
      await searchFilterPanel(page, "Episode Count");
      await expect(page.getByText("Episode Count", { exact: true }), path).toHaveCount(0);
    }
  });

  test("the track-count filters are offered on Movies only", async ({ page }) => {
    await page.route(isPath("/api/media/distinct-values"), (route) =>
      route.fulfill({
        json: { audioStreamCountMin: 1, audioStreamCountMax: 4, subtitleStreamCountMin: 0, subtitleStreamCountMax: 3 },
      }),
    );

    await page.goto("/library/movies");
    await searchFilterPanel(page, "Audio Tracks");
    await expect(page.getByText("Audio Tracks", { exact: true })).toBeVisible();

    for (const path of ["/library/series/episodes", "/library/music/tracks"]) {
      await page.goto(path);
      await searchFilterPanel(page, "Audio Tracks");
      await expect(page.getByText("Audio Tracks", { exact: true }), path).toHaveCount(0);
    }
  });
});
