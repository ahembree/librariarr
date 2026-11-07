import { test, expect, type Page } from "@playwright/test";

/**
 * A large library is read a page at a time as it scrolls (`useLibraryList`):
 * the first page brings the listing's index (its length, the A–Z rail's
 * letters, the header's sums), the rows past the pages read so far are
 * placeholders, and no request ever asks for the whole library (`limit=0`).
 *
 * The listing routes are stubbed with libraries far larger than one page, so
 * the spec controls what each page holds and counts what is asked for.
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PER_LETTER = 200;

/** 5,200 movies, 200 under each letter, sorted by title. */
const MOVIES = [...LETTERS].flatMap((letter) =>
  Array.from({ length: PER_LETTER }, (_, i) => {
    const title = `${letter} Movie ${String(i + 1).padStart(3, "0")}`;
    return {
      id: `e2e-paging-${letter}-${i}`,
      title,
      titleSort: title,
      type: "MOVIE",
      year: 1950 + ((i * 7) % 70),
      duration: null,
      fileSize: "1000",
      resolution: "1080",
      servers: [],
    };
  }),
);

interface Harness {
  /** The query of every movies request, in order. */
  requests: URLSearchParams[];
}

async function stubMovies(page: Page): Promise<Harness> {
  const requests: URLSearchParams[] = [];
  await page.route(isPath("/api/media/movies"), async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const sorted =
      params.get("sortBy") === "year"
        ? [...MOVIES].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
        : MOVIES;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit"));
    const letters: Record<string, number> = {};
    sorted.forEach((m, i) => (letters[m.title[0]] ??= i));
    await route.fulfill({
      json: {
        items: sorted.slice(offset, offset + limit),
        pagination: { page: 1, limit, hasMore: offset + limit < sorted.length },
        ...(params.get("index") === "1" && { index: { total: sorted.length, letters } }),
      },
    });
  });
  return { requests };
}

const card = (page: Page, title: string) => page.locator(`[aria-label="${title}"]`);

test.describe("library paging", () => {
  test("a large movie library is counted at once and read a page at a time", async ({ page }) => {
    const h = await stubMovies(page);
    await page.goto("/library/movies");
    await expect(card(page, "A Movie 001")).toBeVisible();
    await expect(page.getByText(`${MOVIES.length.toLocaleString("en-US")} movies`)).toBeVisible();

    // The first page carries the index; nothing near the end has been read.
    expect(h.requests[0].get("index")).toBe("1");
    expect(h.requests[0].get("offset")).toBe("0");
    expect(h.requests.some((q) => Number(q.get("offset")) > 1000)).toBe(false);

    // Scrolling to the bottom reads the last page and shows the last movie.
    await page.locator("main").evaluate((main) => main.scrollTo({ top: main.scrollHeight }));
    await expect(card(page, "Z Movie 200")).toBeVisible();
    expect(h.requests.some((q) => Number(q.get("offset")) >= MOVIES.length - 100)).toBe(true);
    // Only the pages scrolled to: far fewer than the 52 the library holds.
    expect(h.requests.length).toBeLessThan(15);
    for (const q of h.requests) expect(q.get("limit")).toBe("100");
  });

  test("the A–Z rail jumps to a letter whose rows were never read", async ({ page }) => {
    const h = await stubMovies(page);
    await page.goto("/library/movies");
    await expect(card(page, "A Movie 001")).toBeVisible();

    await page.getByRole("button", { name: "Jump to Q" }).click();
    await expect(card(page, "Q Movie 001")).toBeVisible();
    const qPage = Math.floor(LETTERS.indexOf("Q") * PER_LETTER / 100) * 100;
    expect(h.requests.some((q) => Number(q.get("offset")) === qPage)).toBe(true);
    for (const q of h.requests) expect(q.get("limit")).not.toBe("0");
  });

  test("the table's sort is the server's, and its rows load as it scrolls", async ({ page }) => {
    const h = await stubMovies(page);
    await page.goto("/library/movies");
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator("tbody").getByText("A Movie 001")).toBeVisible();

    await page.locator("thead").getByText("Year", { exact: true }).click();
    await expect.poll(() => h.requests.some((q) => q.get("sortBy") === "year" && q.get("index") === "1")).toBe(true);
    const oldest = [...MOVIES].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))[0];
    await expect(page.locator("tbody").getByText(oldest.title, { exact: true })).toBeVisible();

    await page.locator("main").evaluate((main) => main.scrollTo({ top: main.scrollHeight / 2 }));
    await expect.poll(() => h.requests.some((q) => q.get("sortBy") === "year" && Number(q.get("offset")) >= 2000)).toBe(true);
  });
});

test.describe("library paging — grouped listings", () => {
  test("the Series table sorts on the server and heads the page with the server's sums", async ({ page }) => {
    const shows = Array.from({ length: 450 }, (_, i) => {
      const mediaItemId = `e2e-show-${i}`;
      return {
        parentTitle: `Show ${String(i).padStart(3, "0")}`,
        seriesKey: `tvdb:${i}`,
        mediaItemId,
        episodeCount: (i % 9) + 1,
        seasonCount: 1,
        totalSize: "1000",
        lastPlayed: null,
        addedAt: null,
        qualityCounts: { "1080P": 1 },
        servers: [],
      };
    });
    const requests: URLSearchParams[] = [];
    await page.route(isPath("/api/media/series/grouped"), async (route) => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(params);
      const sorted =
        params.get("sortBy") === "episodeCount"
          ? [...shows].sort((a, b) => (a.episodeCount - b.episodeCount) * (params.get("sortOrder") === "desc" ? -1 : 1))
          : shows;
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit"));
      await route.fulfill({
        json: {
          series: sorted.slice(offset, offset + limit),
          pagination: { page: 1, limit, hasMore: offset + limit < sorted.length },
          ...(params.get("index") === "1" && {
            index: { total: sorted.length, letters: { S: 0 }, sums: { seasons: 450, episodes: 2250 } },
          }),
        },
      });
    });

    await page.goto("/library/series");
    await expect(page.getByText("450 series · 450 seasons · 2,250 episodes")).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator("tbody").getByText("Show 000")).toBeVisible();

    await page.locator("thead").getByText("Episodes", { exact: true }).click();
    await expect.poll(() => requests.some((q) => q.get("sortBy") === "episodeCount")).toBe(true);
    // The table shows the server's order rather than sorting the rows it holds.
    const first = page.locator("tbody tr:not([aria-hidden])").first();
    await expect(first).toContainText(/Show \d{3}/);
    await expect(first.locator("td").nth(2)).toHaveText("1");
    for (const q of requests) expect(q.get("limit")).toBe("100");
  });
});
