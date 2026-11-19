import { test, expect, type Page } from "@playwright/test";

/**
 * Keeping the page where the user left it. Every case runs in a short window
 * — the buttons below the fold, the page scrolled down to reach them — which
 * is where each of these sent the page back to the top:
 *
 * - Run Query: the results table mounting under a scrolled page (TanStack
 *   Virtual writes its starting offset, 0 by default, to `<main>` when it
 *   attaches).
 * - History: a `watch-history:updated` re-read of the page on screen swapped
 *   the table for its shorter skeleton.
 * - Back to top on History: `findScrollContainer` took the table's
 *   `overflow-x-auto` wrapper (computed `overflow-y: auto`) for the page's
 *   scroller, so the button never showed and did nothing.
 * - Matches' table/cards switch: each view is its own scroll box, so the
 *   rule set's list started again from its first item
 *   (`useListPositionMemory`).
 *
 * Data routes are stubbed so the spec decides what each request returns.
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

test.use({ viewport: { width: 1280, height: 500 } });

const mainTop = (page: Page) => page.evaluate(() => document.querySelector("main")!.scrollTop);

/** Hide what floats over the page (toasts) so clicks land on the page. */
async function hideOverlays(page: Page) {
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none !important}" });
}

/** The realtime stream: held until `release(types)`, then connected plus those events. */
async function holdEvents(page: Page) {
  let release: ((types: string[]) => void) | null = null;
  await page.route(isPath("/api/events/stream"), async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200 });
    const types = await new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const data = JSON.stringify({ timestamp: Date.now() });
    await route
      .fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body:
          "retry: 600000\n\n" +
          `event: connected\ndata: ${data}\n\n` +
          types.map((t) => `event: ${t}\ndata: ${data}\n\n`).join(""),
      })
      .catch(() => {});
  });
  return async (types: string[]) => {
    await expect.poll(() => release !== null).toBe(true);
    release!(types);
  };
}

function queryResult(n: number) {
  const title = `Scroll Query Movie ${String(n).padStart(3, "0")}`;
  return {
    id: `scroll-q-${n}`,
    title,
    parentTitle: null,
    seriesKey: null,
    year: 2001,
    type: "MOVIE",
    seasonNumber: null,
    episodeNumber: null,
    summary: null,
    resolution: "1080",
    dynamicRange: null,
    videoCodec: null,
    videoBitDepth: null,
    videoFrameRate: null,
    videoBitrate: null,
    aspectRatio: null,
    audioCodec: null,
    audioChannels: null,
    audioProfile: null,
    container: null,
    fileSize: "1073741824",
    duration: 7_200_000,
    playCount: 0,
    lastPlayedAt: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    originallyAvailableAt: null,
    contentRating: null,
    rating: null,
    ratingImage: null,
    audienceRating: null,
    audienceRatingImage: null,
    isWatchlisted: false,
    genres: null,
    studio: null,
    dedupKey: `movie:title:${title.toLowerCase()}:2001`,
    library: { title: "Movies", mediaServer: { id: "srv-1", name: "Server", type: "PLEX" } },
    servers: [{ serverId: "srv-1", serverName: "Server", serverType: "PLEX" }],
  };
}

function historyRow(n: number) {
  return {
    id: `scroll-wh-${n}`,
    serverUsername: "viewer",
    watchedAt: new Date(Date.UTC(2026, 0, 1) - n * 3_600_000).toISOString(),
    deviceName: null,
    platform: null,
    source: "NATIVE",
    watched: null,
    percentComplete: null,
    isTranscode: null,
    videoDecision: null,
    audioDecision: null,
    player: null,
    product: null,
    resolution: null,
    bitrate: null,
    segmentCount: null,
    durationMs: null,
    totalDurationMs: null,
    progressMs: null,
    mediaItem: {
      id: `scroll-wh-item-${n}`,
      title: `Scroll History Movie ${String(n).padStart(3, "0")}`,
      titleSort: null,
      parentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      year: 2001,
      type: "MOVIE",
      resolution: "1080",
      dynamicRange: null,
      videoCodec: null,
      audioCodec: null,
      audioChannels: null,
      audioProfile: null,
      fileSize: "1073741824",
      duration: 7_200_000,
      summary: null,
      contentRating: null,
      rating: null,
      ratingImage: null,
      audienceRating: null,
      audienceRatingImage: null,
      studio: null,
      playCount: 0,
      lastPlayedAt: null,
      addedAt: "2026-01-01T00:00:00.000Z",
      genres: null,
    },
    server: { id: "srv-1", name: "Server", type: "PLEX" },
  };
}

function matchItem(n: number) {
  const title = `Scroll Match ${String(n).padStart(3, "0")}`;
  return {
    id: `scroll-match-${n}`,
    type: "MOVIE",
    year: 2001,
    arrId: null,
    title,
    artUrl: null,
    genres: null,
    labels: null,
    rating: null,
    studio: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    library: { title: "Movies", mediaServer: { id: "srv-1", name: "Server", type: "PLEX" } },
    servers: [{ serverId: "srv-1", serverName: "Server", serverType: "PLEX" }],
    summary: null,
    dedupKey: `movie:title:${title.toLowerCase()}:2001`,
    duration: 7_200_000,
    fileSize: "1073741824",
    thumbUrl: null,
    playCount: 0,
    seriesKey: null,
    titleSort: null,
    albumTitle: null,
    audioCodec: null,
    resolution: "1080",
    videoCodec: null,
    externalIds: [],
    parentTitle: null,
    ratingImage: null,
    audioProfile: null,
    dynamicRange: null,
    lastPlayedAt: null,
    seasonNumber: null,
    contentRating: null,
    episodeNumber: null,
    audienceRating: null,
    audienceRatingImage: null,
    parentThumbUrl: null,
    seasonThumbUrl: null,
    originallyAvailableAt: null,
    matchedCriteria: [{ field: "Title", value: "Scroll", negate: false, ruleId: "r1", operator: "contains", actualValue: title }],
    detectedAt: "2026-01-01T00:00:00.000Z",
  };
}

const MATCH_RULE_SET = {
  id: "rs-scroll-matches",
  name: "Scroll Matches Rule",
  type: "MOVIE",
  actionEnabled: false,
  actionType: null,
  actionDelayDays: 7,
  arrInstanceId: null,
  targetQualityProfileId: null,
  addImportExclusion: false,
  searchAfterAction: false,
  addArrTags: [],
  removeArrTags: [],
  rules: [{ id: "g1", rules: [{ id: "r1", field: "title", value: "Scroll", operator: "contains", condition: "AND" }], groups: [], condition: "AND" }],
  collectionName: null,
  collectionSort: null,
};

/** Stub the history listing: 50 rows a page; reads after the first wait `delayMs`. */
async function stubHistory(page: Page, delayMs = 0) {
  let reads = 0;
  await page.route(isPath("/api/media/history"), async (route) => {
    reads += 1;
    if (reads > 1 && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route
      .fulfill({
        json: {
          items: Array.from({ length: 50 }, (_, i) => historyRow(i + 1)),
          pagination: { page: 1, limit: 50, hasMore: true, totalCount: 400 },
          usernames: ["viewer"],
          deviceNames: [],
          platforms: [],
        },
      })
      .catch(() => {});
  });
  return () => reads;
}

test.describe("scroll position", () => {
  test("Run Query keeps the page where it was when the results mount", async ({ page }) => {
    await holdEvents(page);
    await page.route(isPath("/api/query"), async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const result = { items: Array.from({ length: 200 }, (_, i) => queryResult(i + 1)), pagination: { page: 1, limit: 0, hasMore: false, total: 200 } };
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
        body: `${JSON.stringify({ type: "result", result })}\n`,
      });
    });
    // A builder with criteria already in it (the page's own draft), so the
    // query can run without driving the builder.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("query-view-mode", JSON.stringify("table"));
      sessionStorage.setItem(
        "query-builder-draft",
        JSON.stringify({
          definition: {
            mediaTypes: ["MOVIE"],
            serverIds: [],
            groups: [{ id: "g1", condition: "AND", rules: [{ id: "r1", field: "title", operator: "contains", value: "Movie", condition: "OR" }], groups: [] }],
            sortBy: "title",
            sortOrder: "asc",
            includeEpisodes: false,
          },
        }),
      );
    });
    await page.goto("/library/query");
    const run = page.getByRole("button", { name: "Run Query" });
    await expect(run).toBeEnabled();
    await hideOverlays(page);

    // Scrolled just far enough to bring Run Query up from below the fold.
    await run.evaluate((b) => b.scrollIntoView({ block: "end" }));
    const before = await mainTop(page);
    expect(before).toBeGreaterThan(0);
    const box = (await run.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByText("Scroll Query Movie 001")).toBeAttached();
    await page.waitForTimeout(500);
    expect(await mainTop(page)).toBe(before);
  });

  test("History: a watch-history event's re-read keeps the rows and the scroll", async ({ page }) => {
    const release = await holdEvents(page);
    const reads = await stubHistory(page, 1500);
    await page.goto("/library/history");
    await expect(page.getByText("Scroll History Movie 001")).toBeVisible();
    await hideOverlays(page);

    await page.evaluate(() => {
      document.querySelector("main")!.scrollTop = 800;
    });
    const before = await mainTop(page);
    expect(before).toBeGreaterThan(700);

    await release(["watch-history:updated"]);
    await expect.poll(reads).toBeGreaterThanOrEqual(2);
    // While the re-read runs: the rows stay and nothing moved.
    await expect(page.getByText("Scroll History Movie 020")).toBeAttached();
    expect(await mainTop(page)).toBe(before);
    // And once it has landed.
    await page.waitForTimeout(2000);
    expect(await mainTop(page)).toBe(before);
  });

  test("History: Back to top shows once scrolled and scrolls the page", async ({ page }) => {
    await holdEvents(page);
    await stubHistory(page);
    await page.goto("/library/history");
    await expect(page.getByText("Scroll History Movie 001")).toBeVisible();
    await hideOverlays(page);

    const backToTop = page.getByRole("button", { name: "Back to top" });
    await page.evaluate(() => {
      document.querySelector("main")!.scrollTop = 1000;
    });
    await expect(backToTop).toHaveCSS("opacity", "1");
    await backToTop.click();
    await expect.poll(() => mainTop(page)).toBe(0);
  });
  test("Matches: switching table and cards keeps the rule set's list at the same item", async ({ page }) => {
    await holdEvents(page);
    const items = Array.from({ length: 150 }, (_, i) => matchItem(i + 1));
    await page.route(isPath("/api/lifecycle/rules/matches"), (route) =>
      route.fulfill({ json: { ruleMatches: [{ ruleSet: MATCH_RULE_SET, items, count: items.length }] } }),
    );
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("matches-view-mode", JSON.stringify("table")));
    await page.goto("/lifecycle/matches");
    await page.getByText("Scroll Matches Rule").click();
    await expect(page.getByText("Scroll Match 001", { exact: true })).toBeVisible();
    await hideOverlays(page);

    /** The rule set's own scroll box and the title at its centre. */
    const centreTitle = () =>
      page.evaluate(() => {
        const box = [...document.querySelectorAll<HTMLElement>("main *")].find(
          (el) => /max-h-\[60dvh\]/.test(String(el.className)) && el.scrollHeight > el.clientHeight + 50,
        )!;
        const r = box.getBoundingClientRect();
        const y = r.top + box.clientHeight / 2;
        for (let x = r.left + 8; x < r.right - 8; x += 24) {
          const title = document
            .elementsFromPoint(x, y)
            .map((el) => el.textContent?.match(/Scroll Match \d{3}/)?.[0])
            .find(Boolean);
          if (title) return { title, top: box.scrollTop };
        }
        return { title: null, top: box.scrollTop };
      });
    const visibleInBox = (title: string) =>
      page.evaluate((title) => {
        const box = [...document.querySelectorAll<HTMLElement>("main *")].find(
          (el) => /max-h-\[60dvh\]/.test(String(el.className)) && el.scrollHeight > el.clientHeight + 50,
        )!;
        const r = box.getBoundingClientRect();
        return [...box.querySelectorAll<HTMLElement>("*")].some((el) => {
          if (el.children.length > 0 || el.textContent?.trim() !== title) return false;
          const e = el.getBoundingClientRect();
          return e.bottom > r.top && e.top < r.bottom;
        });
      }, title);

    await page.evaluate(() => {
      const box = [...document.querySelectorAll<HTMLElement>("main *")].find(
        (el) => /max-h-\[60dvh\]/.test(String(el.className)) && el.scrollHeight > el.clientHeight + 50,
      )!;
      // The page scrolled to bring the list into view, the list scrolled within.
      box.scrollIntoView({ block: "nearest" });
      box.scrollTop = 2500;
    });
    await page.waitForTimeout(500);
    const before = await centreTitle();
    expect(before.top).toBeGreaterThan(2000);
    expect(before.title).not.toBeNull();

    await page.getByRole("button", { name: "Card view" }).first().click();
    await expect.poll(() => visibleInBox(before.title!)).toBe(true);

    await page.getByRole("button", { name: "Table view" }).first().click();
    await expect.poll(() => visibleInBox(before.title!)).toBe(true);
    expect(Math.abs((await centreTitle()).top - before.top)).toBeLessThan(100);
  });
});

