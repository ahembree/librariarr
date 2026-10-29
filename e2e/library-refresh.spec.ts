import { test, expect, type Page } from "@playwright/test";

/**
 * A sync that adds an item while a library page is open updates the list in
 * place (`useLibraryList`). The page used to show its skeleton, then the first
 * 100 rows, then the whole library again, so every sync that added a movie
 * flashed the whole page.
 *
 * `/api/media/movies` is stubbed so the spec controls the library and can hold
 * the first-page answer, and `/api/events/stream` is held open until the test
 * releases one `sync:completed`, as `dashboard-refresh.spec.ts` does.
 */

const FIRST_CHUNK = 100;
const isPath = (path: string) => (url: URL) => url.pathname === path;

function movie(n: number, title = `Movie ${String(n).padStart(3, "0")}`) {
  return {
    id: `e2e-refresh-${n}`,
    title,
    titleSort: title,
    type: "MOVIE",
    year: 2000,
    duration: null,
    fileSize: "1000",
    resolution: "1080",
    servers: [],
  };
}

interface Harness {
  /** The query string of every movies request, in order. */
  requests: string[];
  /** The library the route answers from now on. */
  setMovies: (list: ReturnType<typeof movie>[]) => void;
  /** Hold every first-page answer until the returned function is called. */
  holdFirstPage: () => () => void;
  /** Deliver one `sync:completed` for movies. */
  fireSyncCompleted: () => Promise<void>;
}

async function setup(page: Page): Promise<Harness> {
  let movies = Array.from({ length: FIRST_CHUNK + 20 }, (_, i) => movie(i + 1));
  const requests: string[] = [];
  let gate: Promise<void> | null = null;
  let releaseStream: ((event: string) => void) | null = null;

  await page.route(isPath("/api/media/movies"), async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const offset = url.searchParams.get("offset");
    const limit = Number(url.searchParams.get("limit") ?? 0);
    if (offset === null && gate) await gate;
    const start = offset ? Number(offset) : 0;
    const items = limit > 0 ? movies.slice(start, start + limit) : movies.slice(start);
    await route.fulfill({
      json: { items, pagination: { page: 1, limit, hasMore: limit > 0 && start + limit < movies.length } },
    });
  });
  await page.route(isPath("/api/events/stream"), async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200 });
    const event = await new Promise<string>((resolve) => {
      releaseStream = resolve;
    });
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body:
        "retry: 600000\n\n" +
        `event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n` +
        `event: ${event}\ndata: ${JSON.stringify({ timestamp: Date.now(), libraryTypes: ["MOVIE"] })}\n\n`,
    });
  });

  return {
    requests,
    setMovies: (list) => {
      movies = list;
    },
    holdFirstPage: () => {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    fireSyncCompleted: async () => {
      await expect.poll(() => releaseStream !== null).toBe(true);
      releaseStream!("sync:completed");
    },
  };
}

const card = (page: Page, title: string) => page.locator(`[aria-label="${title}"]`);

test.describe("library refresh", () => {
  test("a sync that adds a movie updates the Movies page in place", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/library/movies");
    await expect(card(page, "Movie 001")).toBeVisible();
    await expect(page.getByText(`${FIRST_CHUNK + 20} movies`)).toBeVisible();

    // Mark a card that stays in its row, and watch for the grid skeleton.
    await card(page, "Movie 001").evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
    await page.evaluate(() => {
      const w = window as unknown as { __skeletonSeen: boolean };
      w.__skeletonSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-slot="skeleton"][class*="aspect-2/3"]')) w.__skeletonSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const before = h.requests.length;

    h.setMovies([movie(0, "AAA New Movie"), ...Array.from({ length: FIRST_CHUNK + 20 }, (_, i) => movie(i + 1))]);
    const releaseFirstPage = h.holdFirstPage();
    await h.fireSyncCompleted();

    // The refresh asks for the rest without waiting for the first screenful.
    await expect
      .poll(() => h.requests.slice(before).filter((q) => q.includes(`offset=${FIRST_CHUNK}`)).length)
      .toBe(1);
    // Until the whole list is in, the old one stays.
    await expect(card(page, "AAA New Movie")).toHaveCount(0);
    await expect(page.getByText(`${FIRST_CHUNK + 20} movies`)).toBeVisible();
    releaseFirstPage();

    await expect(card(page, "AAA New Movie")).toBeVisible();
    await expect(page.getByText(`${FIRST_CHUNK + 21} movies`)).toBeVisible();
    // No skeleton at any point, and the existing card was never remounted.
    expect(await page.evaluate(() => (window as unknown as { __skeletonSeen: boolean }).__skeletonSeen)).toBe(false);
    await expect(card(page, "Movie 001")).toHaveAttribute("data-e2e-kept", "1");
  });
});
