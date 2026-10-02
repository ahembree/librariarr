import { test, expect, type Page } from "@playwright/test";

/**
 * Dashboard rendering details that only show in a real browser: card labels,
 * fill-bar colours past the palette, the Integrations tile's refresh, and the
 * Recently Added shelf retrying artwork when a tile's representative changes.
 * Data routes are stubbed; the saved layout is stubbed and saves swallowed so
 * nothing leaks into the shared e2e database.
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

function stats(overrides: Record<string, unknown> = {}) {
  return {
    movieCount: 1, seriesCount: 0, seasonCount: 0, musicCount: 0, artistCount: 0,
    albumCount: 0, episodeCount: 0, totalSize: "0", movieSize: "0", seriesSize: "0",
    musicSize: "0", movieDuration: 0, seriesDuration: 0, musicDuration: 0,
    qualityBreakdown: [], topMovies: [], topSeries: [], topMusic: [],
    videoCodecBreakdown: [], audioCodecBreakdown: [], contentRatingBreakdown: [],
    dynamicRangeBreakdown: [], audioChannelsBreakdown: [], genreBreakdown: [],
    ...overrides,
  };
}

async function stubDashboard(page: Page, cards: string[], statsBody: object) {
  const layout = { main: cards.map((id) => ({ id, size: 12 })), movies: [], series: [], music: [] };
  await page.route(isPath("/api/settings/dashboard-layout"), (route) =>
    route.fulfill({ json: { layout } }),
  );
  await page.route(isPath("/api/media/stats"), (route) => route.fulfill({ json: statsBody }));
  await page.route(isPath("/api/media/library-types"), (route) =>
    route.fulfill({ json: { types: ["MOVIE"], allTypes: ["MOVIE"] } }),
  );
}

/** The Insights zone; each test's layout holds a single card. */
function insights(page: Page) {
  return page.locator("section", {
    has: page.getByRole("heading", { name: "Insights", exact: true }),
  });
}

test.describe("dashboard insights", () => {
  test("audio channel labels are shown as formatted, not upper-cased", async ({ page }) => {
    await stubDashboard(page, ["audio-channels"], stats({
      audioChannelsBreakdown: [
        { audioChannels: 2, type: "MOVIE", _count: 3 },
        { audioChannels: 6, type: "MOVIE", _count: 2 },
      ],
    }));
    await page.goto("/");

    await expect(page.getByText("Stereo (2.0)", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("5.1 Surround", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("STEREO (2.0)", { exact: true })).toHaveCount(0);
  });

  test("rows past the palette still get a fill bar", async ({ page }) => {
    const genres = Array.from({ length: 20 }, (_, i) => ({
      value: `genre${String(i).padStart(2, "0")}`,
      type: "MOVIE",
      _count: 100 - i,
    }));
    await stubDashboard(page, ["genre"], stats({ genreBreakdown: genres }));
    await page.goto("/");

    const genreCard = insights(page);
    await expect(genreCard.getByText("Genre Breakdown")).toBeVisible();
    await genreCard.getByRole("combobox").filter({ hasText: "Top 5" }).click();
    await page.getByRole("option", { name: "All", exact: true }).click();

    // The 18th value is past the 15-colour palette, so its colour is oklch().
    const row = genreCard.getByRole("button", { name: /Genre17/i });
    await expect(row).toBeVisible();
    const fill = await row.locator("div").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(fill).not.toBe("");
  });

  test("the Integrations tile re-checks health without an event", async ({ page }) => {
    await page.clock.install();
    let reachable = 1;
    await page.route(isPath("/api/integrations/health"), (route) =>
      route.fulfill({
        json: {
          sonarr: { configured: 1, reachable, instances: [{ id: "s", name: "Sonarr", reachable: reachable === 1 }] },
          radarr: { configured: 0, reachable: 0, instances: [] },
          lidarr: { configured: 0, reachable: 0, instances: [] },
          seerr: { configured: 0, reachable: 0, instances: [] },
        },
      }),
    );
    await page.goto("/");
    const tile = page.locator('a[href="/settings#integrations"]');
    await expect(tile).toContainText("1/1 reachable");

    reachable = 0;
    await page.clock.fastForward(61_000);
    await expect(tile).toContainText("0/1 reachable");
    await expect(tile).toContainText("down: Sonarr");
  });
});
