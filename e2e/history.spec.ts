import { test, expect, type Page, type Route } from "@playwright/test";
import { seedHistory, cleanupHistorySeed, HISTORY_SEED } from "./history-seed";

/**
 * The watch-history lists in a real browser: the History page's server-side
 * sorting, paging, failure handling and Refresh, and a movie's per-play card.
 *
 * These replace source-text assertions that could not tell working wiring
 * from broken (the suite has no DOM renderer), so every test here drives the
 * real component against the real route and checks what is ON SCREEN — the
 * row order, the scroll position, the rows kept over a failure.
 */

const HISTORY_PATH = "/api/media/history";

/** Matches only the listing (`/api/media/history?…`), not `/sync`. */
const isHistoryListing = (url: URL) => url.pathname === HISTORY_PATH;

/**
 * The text of one column for the first `n` rows on screen, in row order.
 * DataTable virtualizes, so rows are read by their `data-index`, and the
 * column by its header's position. `innerText`, not `textContent`: a server
 * chip also renders an invisible copy of its name to measure.
 */
async function columnTexts(page: Page, header: string, n = 8): Promise<string[]> {
  return page.evaluate(
    ([header, n]) => {
      const ths = [...document.querySelectorAll("thead th")];
      const idx = ths.findIndex((th) => th.textContent?.trim() === header);
      if (idx < 0) return [`<no column ${header}>`];
      return [...document.querySelectorAll("tbody tr[data-index]")]
        .sort((a, b) => Number(a.getAttribute("data-index")) - Number(b.getAttribute("data-index")))
        .slice(0, n)
        .map((row) => (row.children[idx] as HTMLElement | undefined)?.innerText.trim() ?? "");
    },
    [header, n] as const,
  );
}

async function rowCount(page: Page): Promise<number> {
  return page.locator("tbody tr[data-index]").count();
}

/** The History page's page-number field (it is the only pagination on it). */
const pageNumber = (page: Page) => page.getByRole("textbox", { name: "Page number" });

async function openHistory(page: Page) {
  await page.goto("/library/history");
  await expect(page.getByText(`${HISTORY_SEED.totalPlays} plays`)).toBeVisible();
  await expect(page.locator("tbody tr[data-index]").first()).toBeVisible();
}

/**
 * Holds `/api/events/stream` open until `fire()`, then delivers one `event`
 * (as a real import or sync does) and ends the stream. `retry` keeps the
 * browser from reconnecting for the rest of the test: a re-open fires every
 * subscriber's callback once (`fireResync`), which would refetch whatever the
 * test is waiting for whether or not the page listens for `event`.
 */
async function holdEventStream(page: Page, event: string) {
  let release: (() => void) | null = null;
  await page.route((url) => url.pathname === "/api/events/stream", async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200 });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body:
        "retry: 600000\n\n" +
        "event: connected\ndata: {}\n\n" +
        `event: ${event}\ndata: ${JSON.stringify({ type: event, timestamp: Date.now(), meta: {} })}\n\n`,
    });
  });
  return {
    fire: async () => {
      await expect.poll(() => release !== null).toBe(true);
      release!();
    },
  };
}

test.describe("watch history", () => {
  test.beforeAll(async () => {
    await seedHistory();
  });

  test.afterAll(async () => {
    await cleanupHistorySeed();
  });

  test("the User header toggles ascending → descending, and Server sorts by server name", async ({ page }) => {
    await openHistory(page);
    const user = page.getByRole("columnheader", { name: "User", exact: true });
    const server = page.getByRole("columnheader", { name: "Server", exact: true });

    await user.click();
    await expect(user).toHaveAttribute("aria-sort", "ascending");
    await expect.poll(() => columnTexts(page, "User")).toEqual(Array(8).fill(HISTORY_SEED.userB));
    await expect.poll(() => columnTexts(page, "Server")).toEqual(Array(8).fill(HISTORY_SEED.serverB));

    await user.click();
    await expect(user).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => columnTexts(page, "User")).toEqual(Array(8).fill(HISTORY_SEED.userA));

    // Every Alpha play is bob's and every Bravo play alice's, so a Server
    // header that sorted by user (as it once did) would lead with alice/Bravo.
    await server.click();
    await expect(server).toHaveAttribute("aria-sort", "ascending");
    await expect(user).toHaveAttribute("aria-sort", "none");
    await expect.poll(() => columnTexts(page, "Server")).toEqual(Array(8).fill(HISTORY_SEED.serverA));
    await expect.poll(() => columnTexts(page, "User")).toEqual(Array(8).fill(HISTORY_SEED.userA));

    await server.click();
    await expect(server).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => columnTexts(page, "Server")).toEqual(Array(8).fill(HISTORY_SEED.serverB));
  });

  test("a Title sort orders episodes by show, then season and episode number", async ({ page }) => {
    await openHistory(page);
    await page.getByRole("columnheader", { name: "Title", exact: true }).click();
    // The episode titles run against their numbers (S01E01 is "Zulu"), and
    // S01E10 must follow S01E02 — so only show → season → episode gives this.
    await expect
      .poll(() => columnTexts(page, "Title", 6))
      .toEqual([...HISTORY_SEED.episodesInOrder, "Title 01", "Title 01"]);

    await page.getByRole("columnheader", { name: "Title", exact: true }).click();
    await expect.poll(async () => (await columnTexts(page, "Title", 1))[0]).toBe("Title 10");
  });

  test("paging from the bottom of the table scrolls back to the table's top", async ({ page }) => {
    await openHistory(page);
    const next = page.getByRole("button", { name: "Next page" });
    await next.scrollIntoViewIfNeeded();

    const anchorTop = () =>
      page.getByTestId("history-table-top").evaluate((el) => el.getBoundingClientRect().top);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    // Precondition: the table's top really is scrolled out of view.
    expect(await anchorTop()).toBeLessThan(0);

    await next.click();
    await expect(pageNumber(page)).toHaveValue("2");
    await expect.poll(anchorTop).toBeGreaterThanOrEqual(0);
    expect(await anchorTop()).toBeLessThan(viewportHeight / 2);
    // ...and the first row of the new page is on screen to read.
    await expect(page.locator('tbody tr[data-index="0"]')).toBeInViewport();
  });

  test("a failed page load keeps the rows on screen under a Retry notice", async ({ page }) => {
    await openHistory(page);
    const firstPageDevices = await columnTexts(page, "Device", 5);

    await page.route(isHistoryListing, (route) => route.fulfill({ status: 500, body: "{}" }), { times: 1 });
    await page.getByRole("button", { name: "Next page" }).click();

    const notice = page.getByText(/Couldn.t load watch history — the plays below may be out of date/);
    await expect(notice).toBeVisible();
    // The previous page stays — not the "No watch history … Sync Now" empty
    // state, which told the user they had no history.
    expect(await columnTexts(page, "Device", 5)).toEqual(firstPageDevices);
    await expect(page.getByText("No watch history")).toHaveCount(0);
    await expect(pageNumber(page)).toHaveValue("1");

    // Retry asks again for the page that failed (2), not the one on screen.
    const retried = page.waitForResponse((r) => isHistoryListing(new URL(r.url())) && r.ok());
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    expect(new URL((await retried).url()).searchParams.get("page")).toBe("2");
    await expect(notice).toHaveCount(0);
    await expect(pageNumber(page)).toHaveValue("2");
    await expect.poll(() => rowCount(page)).toBe(HISTORY_SEED.totalPlays - 100);
    expect(await columnTexts(page, "Device", 5)).not.toEqual(firstPageDevices);
  });

  test("Refresh then a filter change: the table reflects the filter when the sync ends", async ({ page }) => {
    await openHistory(page);

    // Hold the sync open until the filter has changed, then answer with the
    // smallest valid progress stream: one terminal `result` line.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/media/history/sync", async (route: Route) => {
      await released;
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "result", result: { success: true, counts: {}, cancelled: false } })}\n`,
      });
    });

    const syncStarted = page.waitForRequest("**/api/media/history/sync");
    await page.getByRole("button", { name: "Refresh" }).click();
    await syncStarted;
    await expect(page.getByRole("button", { name: "Syncing..." })).toBeVisible();

    const filtered = page.waitForResponse(
      (r) => isHistoryListing(new URL(r.url())) && new URL(r.url()).searchParams.get("type") === "SERIES",
    );
    await page.getByRole("button", { name: "Series", exact: true }).click();
    await filtered;
    await expect.poll(() => rowCount(page)).toBe(4);

    // The reload the sync's end triggers must carry the filter on screen NOW,
    // not the one in force when Refresh was clicked.
    const afterSync = page.waitForResponse((r) => isHistoryListing(new URL(r.url())));
    release();
    expect(new URL((await afterSync).url()).searchParams.get("type")).toBe("SERIES");
    await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
    await expect.poll(() => rowCount(page)).toBe(4);
    expect(await columnTexts(page, "Type", 4)).toEqual(Array(4).fill("Series"));
  });

  test("a filter that matches nothing offers Clear filters, not Sync Now", async ({ page }) => {
    await openHistory(page);
    const search = page.getByPlaceholder("Search titles...");
    const searched = page.waitForResponse(
      (r) => isHistoryListing(new URL(r.url())) && new URL(r.url()).searchParams.get("search") === "no such title",
    );
    await search.fill("no such title");
    await searched;

    // The history has plays, so an empty answer is the filters' doing. It used
    // to read "No watch history … Sync Now", telling the user they had none.
    await expect(page.getByText("No plays match these filters")).toBeVisible();
    await expect(page.getByText("No watch history")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sync Now" })).toHaveCount(0);

    const cleared = page.waitForResponse(
      (r) => isHistoryListing(new URL(r.url())) && !new URL(r.url()).searchParams.has("search"),
    );
    await page.getByRole("button", { name: "Clear filters" }).click();
    await cleared;
    await expect(search).toHaveValue("");
    await expect(page.getByText(`${HISTORY_SEED.totalPlays} plays`)).toBeVisible();
    await expect.poll(() => rowCount(page)).toBeGreaterThan(0);
    await expect(page.getByText("No plays match these filters")).toHaveCount(0);
  });

  // A Tracearr backfill slice and the per-playback history job announce
  // `watch-history:updated` and never `sync:completed`, which is all the
  // series pages used to listen for — so their play lists stayed stale until
  // the next full sync while the movie and track pages refreshed.
  for (const [kind, scope] of [
    ["show", {}],
    ["season", { seasonNumber: "1" }],
    ["episode", { seasonNumber: "1", episodeNumber: "1" }],
  ] as const) {
    test(`the ${kind} page's play list re-reads when plays are imported`, async ({ page }) => {
      const stream = await holdEventStream(page, "watch-history:updated");
      const isSeriesPlays = (url: URL) => url.pathname === "/api/media/series/watch-history";
      const firstRead = page.waitForResponse((r) => isSeriesPlays(new URL(r.url())) && r.ok());
      await page.goto(`/library/series/${kind}/${HISTORY_SEED.episodeId}`);
      await firstRead;
      await expect(page.getByTestId("play-history")).toBeVisible();

      const reread = page.waitForRequest((r) => isSeriesPlays(new URL(r.url())));
      await stream.fire();
      // The same list, re-read in place.
      const params = new URL((await reread).url()).searchParams;
      expect(params.get("seriesKey")).toBe(HISTORY_SEED.seriesKey);
      expect(params.get("page")).toBe("1");
      for (const [key, value] of Object.entries(scope)) expect(params.get(key)).toBe(value);
    });
  }

  test("a movie's play card keeps its rows and offers Retry when a page fails", async ({ page }) => {
    const playsPath = `/api/media/${HISTORY_SEED.detailMovieId}/plays`;
    await page.goto(`/library/movies/${HISTORY_SEED.detailMovieId}`);
    const card = page.getByTestId("play-history");
    await expect(card.getByText(`(${HISTORY_SEED.playsPerMovie} plays)`)).toBeVisible();
    const rows = card.locator("li");
    await expect(rows).toHaveCount(5);
    const firstPage = await rows.allTextContents();

    await page.route((url) => url.pathname === playsPath, (route) => route.fulfill({ status: 500, body: "{}" }), {
      times: 1,
    });
    await card.getByRole("button", { name: "Next page" }).click();

    await expect(card.getByText(/Couldn.t load this page — showing the plays loaded before/)).toBeVisible();
    await expect(rows).toHaveCount(5);
    expect(await rows.allTextContents()).toEqual(firstPage);
    await expect(card.getByText("Could not load watch history")).toHaveCount(0);
    // Pagination is still there, so the user is not stuck.
    await expect(card.getByRole("button", { name: "Next page" })).toBeEnabled();

    const retried = page.waitForResponse((r) => new URL(r.url()).pathname === playsPath && r.ok());
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    expect(new URL((await retried).url()).searchParams.get("page")).toBe("2");
    await expect(card.getByRole("textbox", { name: "Page number" })).toHaveValue("2");
    await expect(card.getByText(/Couldn.t load this page/)).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    expect(await rows.allTextContents()).not.toEqual(firstPage);
  });
});
