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

/** One row of `/api/media/series/grouped` (single server: the presence is that server). */
function show(parentTitle: string, seriesKey: string) {
  const mediaItemId = `mi-${seriesKey}`;
  return {
    parentTitle,
    seriesKey,
    mediaItemId,
    episodeCount: 10,
    seasonCount: 1,
    totalSize: "21474836480",
    lastPlayed: null,
    addedAt: "2024-03-01T12:00:00.000Z",
    watchedEpisodeCount: 0,
    watchedEpisodePercentage: 0,
    lastEpisodeAiredAt: "2008-03-09T00:00:00.000Z",
    isWatchlisted: false,
    qualityCounts: { "1080P": 10 },
    thumbUrl: null,
    servers: [{ serverId: "srv-1", serverName: "Plex", serverType: "PLEX", mediaItemId }],
    summary: null,
    genres: ["Drama"],
    studio: null,
    contentRating: "TV-MA",
    rating: null,
    ratingImage: null,
    audienceRating: null,
    audienceRatingImage: null,
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
          series: search
            ? [show("Server Answer", "tvdb:81189")]
            : [show("Unfiltered One", "tvdb:79168"), show("Unfiltered Two", "tvdb:73255")],
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
  /**
   * Searches the open panel for `label` and asserts it is not offered. The
   * search first shows `control`, a filter this listing does offer, and the
   * absence is checked only once `control` has gone under the new search —
   * checked straight after typing, it would pass before the panel redrew.
   */
  async function expectNotOffered(page: Page, label: string, control: string, path: string) {
    const search = page.getByPlaceholder("Search filters...");
    await search.fill(control);
    await expect(page.getByText(control, { exact: true }), path).toBeVisible();
    await search.fill(label);
    await expect(page.getByText(control, { exact: true }), path).toHaveCount(0);
    await expect(page.getByText(label, { exact: true }), path).toHaveCount(0);
  }

  test("the show-level filters are offered on the Series tab only", async ({ page }) => {
    await page.goto("/library/series");
    await searchFilterPanel(page, "Episode Count");
    await expect(page.getByText("Episode Count", { exact: true })).toBeVisible();

    for (const path of ["/library/series/seasons", "/library/series/episodes"]) {
      await page.goto(path);
      await searchFilterPanel(page, "Play Count");
      await expectNotOffered(page, "Episode Count", "Play Count", path);
    }
  });

  test("the track-count filters are offered on Movies only", async ({ page }) => {
    // Content Rating is drawn from the same answer as the track counts, so its
    // presence shows the values have arrived — before that the track-count
    // section would be missing on Movies too.
    await page.route(isPath("/api/media/distinct-values"), (route) =>
      route.fulfill({
        json: {
          contentRating: ["PG-13", "R"],
          audioStreamCountMin: 1,
          audioStreamCountMax: 4,
          subtitleStreamCountMin: 0,
          subtitleStreamCountMax: 3,
        },
      }),
    );

    await page.goto("/library/movies");
    await searchFilterPanel(page, "Audio Tracks");
    await expect(page.getByText("Audio Tracks", { exact: true })).toBeVisible();

    for (const path of ["/library/series/episodes", "/library/music/tracks"]) {
      await page.goto(path);
      await searchFilterPanel(page, "Content Rating");
      await expectNotOffered(page, "Audio Tracks", "Content Rating", path);
    }
  });
});
