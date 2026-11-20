import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Lifecycle pages keeping what they show in step with the request that asked
 * for it. Every data route is stubbed, so the spec decides what each request
 * returns and how long it takes.
 *
 * - Matches: Run / Re-evaluate All re-read the stored matches. The run's own
 *   result rows are detection's shape (no collection name, no profile target,
 *   no match dates); spliced into the page they wiped those details until a
 *   reload.
 * - Pending and Exceptions: a slow response for the tab the user just left
 *   must not land on the tab they switched to.
 * - Exceptions: series rows are grouped by series identity, never by title,
 *   so two different shows sharing a title stay two rows (and two Removes).
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

/** A rule set as `/api/lifecycle/rules/matches` lists it (with its collection). */
function ruleSet(overrides: Record<string, unknown> = {}) {
  return {
    id: "rs-leaving",
    name: "Leaving Soon Movies",
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
    collectionName: "Leaving Soon",
    collectionSort: "ALPHABETICAL",
    ...overrides,
  };
}

/** Fulfil after `ms`, so a later request can overtake this one. */
async function fulfillLater(route: Route, ms: number, json: unknown) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await route.fulfill({ json }).catch(() => {});
}

/** Keep the realtime stream from resyncing the page mid-test. */
async function quietEvents(page: Page) {
  await page.route(isPath("/api/events/stream"), (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: `retry: 600000\n\nevent: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`,
    }),
  );
}

test.describe("lifecycle — matches after a run", () => {
  for (const button of ["Re-evaluate", "Re-evaluate All"] as const) {
    test(`${button} keeps the rule set's collection label`, async ({ page }) => {
      await quietEvents(page);
      let matchesGets = 0;
      await page.route(isPath("/api/lifecycle/rules/matches"), (route) => {
        matchesGets++;
        return route.fulfill({ json: { ruleMatches: [{ ruleSet: ruleSet(), items: [], count: 0 }] } });
      });
      // Detection's result rows (`{ ruleMatches, skipped }`): the same rule set
      // without the listing-only collection fields.
      await page.route(isPath("/api/lifecycle/rules/run"), (route) => {
        const detectionRow: Record<string, unknown> = ruleSet();
        delete detectionRow.collectionName;
        delete detectionRow.collectionSort;
        return route.fulfill({
          json: { ruleMatches: [{ ruleSet: detectionRow, items: [], count: 0 }], skipped: [] },
        });
      });

      await page.goto("/lifecycle/matches");
      await expect(page.getByText("Collection: Leaving Soon")).toBeVisible();
      const before = matchesGets;

      const ran = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/lifecycle/rules/run");
      await page.getByRole("button", { name: button, exact: true }).click();
      await ran;

      await expect.poll(() => matchesGets).toBeGreaterThan(before);
      await expect(page.getByRole("button", { name: button, exact: true })).toBeEnabled();
      await expect(page.getByText("Collection: Leaving Soon")).toBeVisible();
    });
  }
});

test.describe("lifecycle — matches after overlapping runs", () => {
  // Two rule sets re-evaluated side by side each re-read the whole listing
  // when their run returns. The first re-read can answer last; landing over
  // the newer one it put the second rule set's pre-run matches back on screen.
  test("an earlier, slower re-read does not overwrite a newer one", async ({ page }) => {
    await quietEvents(page);
    const listing = (bCollection: string) => ({
      ruleMatches: [
        { ruleSet: ruleSet({ id: "rs-a", name: "Rule A", collectionName: "A Shelf" }), items: [], count: 0 },
        { ruleSet: ruleSet({ id: "rs-b", name: "Rule B", collectionName: bCollection }), items: [], count: 0 },
      ],
    });
    // Before the clicks every read answers "B Before" at once. Once Rule A's
    // run has been asked for, a read made before Rule B's run returns is the
    // stale one, and slow; a read after it answers "B After".
    let clicked = false;
    let bReturned = false;
    let staleDelivered = false;
    let reads = 0;
    await page.route(isPath("/api/lifecycle/rules/matches"), async (route) => {
      reads++;
      if (!clicked) return route.fulfill({ json: listing("B Before") });
      if (!bReturned) {
        await fulfillLater(route, 1500, listing("B Before"));
        staleDelivered = true;
        return;
      }
      return route.fulfill({ json: listing("B After") });
    });
    await page.route(isPath("/api/lifecycle/rules/run"), async (route) => {
      const { ruleSetId } = route.request().postDataJSON() as { ruleSetId: string };
      if (ruleSetId !== "rs-b") return route.fulfill({ json: { ruleMatches: [], skipped: [] } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      bReturned = true;
      await route.fulfill({ json: { ruleMatches: [], skipped: [] } });
    });

    await page.goto("/lifecycle/matches");
    await expect(page.getByText("Collection: B Before")).toBeVisible();

    // Each rule set's own button: while one runs its label changes, so the two
    // are found by their cards, and the second click lands mid-run.
    const reEvaluate = (name: string) =>
      page.locator('[data-slot="card"]', { hasText: name }).getByRole("button", { name: /^Re-evaluat/ });
    clicked = true;
    await reEvaluate("Rule A").click();
    await reEvaluate("Rule B").click();

    await expect(page.getByText("Collection: B After")).toBeVisible();
    // The stale read lands after the newer one, and must be dropped.
    await expect.poll(() => staleDelivered, { timeout: 10_000 }).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3);
    // Nothing on the page changes when a stale answer is dropped, so give it
    // a moment to (not) apply what it has just received before looking.
    await page.waitForTimeout(500);
    await expect(page.getByText("Collection: B After")).toBeVisible();
    await expect(page.getByText("Collection: B Before")).toHaveCount(0);
  });
});

test.describe("lifecycle — stale responses", () => {
  test("Pending: a slow Pending listing does not land on the Completed tab", async ({ page }) => {
    await quietEvents(page);
    let pendingDelivered = false;
    await page.route(isPath("/api/lifecycle/actions"), async (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      if (status === "PENDING") {
        await fulfillLater(route, 1500, {
          groups: [
            {
              ruleSet: {
                id: "rs-stale",
                name: "Stale Pending Rule",
                type: "MOVIE",
                actionType: "DELETE_RADARR",
                actionDelayDays: 7,
                addImportExclusion: false,
                searchAfterAction: false,
                addArrTags: [],
                removeArrTags: [],
                arrInstanceId: null,
              },
              items: [],
              count: 0,
            },
          ],
        });
        pendingDelivered = true;
        return;
      }
      return route.fulfill({ json: { groups: [] } });
    });

    // The Pending request is made once the page has hydrated, so the click
    // below cannot land on inert server-rendered markup.
    const pendingAsked = page.waitForRequest((req) => new URL(req.url()).searchParams.get("status") === "PENDING");
    await page.goto("/lifecycle/pending");
    await pendingAsked;
    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(page.getByText(/no completed actions yet/i)).toBeVisible();

    // The Pending answer arrives after the Completed one …
    await expect.poll(() => pendingDelivered, { timeout: 10_000 }).toBe(true);
    // Dropping it changes nothing on screen: a moment to (not) apply it.
    await page.waitForTimeout(500);
    // … and is ignored.
    await expect(page.getByText("Stale Pending Rule")).toHaveCount(0);
    await expect(page.getByText(/no completed actions yet/i)).toBeVisible();
  });

  test("Exceptions: a slow Movies listing does not land on the Series tab", async ({ page }) => {
    await quietEvents(page);
    let moviesDelivered = false;
    await page.route(isPath("/api/lifecycle/exceptions"), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const type = new URL(route.request().url()).searchParams.get("type");
      if (type === "MOVIE") {
        await fulfillLater(route, 1500, {
          exceptions: [exception("ex-movie", { id: "mi-movie", title: "Stale Movie Title", type: "MOVIE" })],
        });
        moviesDelivered = true;
        return;
      }
      return route.fulfill({ json: { exceptions: [] } });
    });

    const moviesAsked = page.waitForRequest((req) => new URL(req.url()).searchParams.get("type") === "MOVIE");
    await page.goto("/lifecycle/exceptions");
    await moviesAsked;
    await page.getByRole("tab", { name: "Series", exact: true }).click();
    await expect(page.getByText(/no exceptions/i)).toBeVisible();

    await expect.poll(() => moviesDelivered, { timeout: 10_000 }).toBe(true);
    // Dropping it changes nothing on screen: a moment to (not) apply it.
    await page.waitForTimeout(500);
    await expect(page.getByText("Stale Movie Title")).toHaveCount(0);
    await expect(page.getByText(/no exceptions/i)).toBeVisible();
  });
});

test.describe("lifecycle — re-reads keep the list on screen", () => {
  test("Pending: an Execute's re-read keeps the rows and both scroll positions", async ({ page }) => {
    await quietEvents(page);
    const listing = { groups: [pendingGroup("rs-scroll", "Scroll Keep Rule", 60)] };
    let listingReads = 0;
    await page.route(isPath("/api/lifecycle/actions"), async (route) => {
      listingReads += 1;
      // The first read paints the page; the re-read after Execute is slow, so
      // the test can look at the page while it is under way.
      if (listingReads === 1) return route.fulfill({ json: listing });
      await fulfillLater(route, 1500, listing);
    });
    // A refusal: the page re-reads the listing at once.
    await page.route(isPath("/api/lifecycle/actions/execute"), (route) =>
      route.fulfill({ status: 409, json: { error: "Refused for the test" } }),
    );

    await page.goto("/lifecycle/pending");
    await page.getByText("Scroll Keep Rule").click();
    await expect(page.getByText("Scroll Movie 01", { exact: true })).toBeVisible();

    // The rule set's rows scroll in their own box, inside the page's scroller.
    const scrollers = () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll("td, p, span")].find(
          (el) => el.textContent?.trim() === "Scroll Movie 01",
        );
        const boxes: HTMLElement[] = [];
        for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
          const { overflowY } = getComputedStyle(el);
          if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) boxes.push(el);
        }
        return boxes.map((box) => box.scrollTop);
      });
    await page.evaluate(() => {
      const row = [...document.querySelectorAll("td, p, span")].find(
        (el) => el.textContent?.trim() === "Scroll Movie 01",
      );
      for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) el.scrollTop = 150;
      }
    });
    const before = await scrollers();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((top) => top > 0)).toBe(true);

    // A row on screen, clicked where it is (a locator click would scroll it).
    const reread = page.waitForRequest(
      (req) => isPath("/api/lifecycle/actions")(new URL(req.url())) && req.method() === "GET",
    );
    await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Execute now"]')].find((b) => {
        const r = b.getBoundingClientRect();
        return r.top > 0 && r.bottom < window.innerHeight;
      });
      button?.click();
    });
    await reread;

    // While the re-read runs, the rows stay and nothing scrolled.
    await expect(page.getByText("Scroll Movie 01", { exact: true })).toBeAttached();
    expect(await scrollers()).toEqual(before);
    // And once it has landed.
    await expect.poll(() => listingReads).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1800);
    expect(await scrollers()).toEqual(before);
  });
});

/** A group of `GET /api/lifecycle/actions`: a rule set and `count` pending movie actions. */
function pendingGroup(id: string, name: string, count: number) {
  const items = Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      id: `${id}-action-${n}`,
      actionType: "DELETE_RADARR",
      addImportExclusion: false,
      addArrTags: [],
      removeArrTags: [],
      targetQualityProfileId: null,
      status: "PENDING",
      scheduledFor: "2030-01-01T00:00:00.000Z",
      executedAt: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      estimated: false,
      mediaItem: {
        id: `${id}-item-${n}`,
        title: `Scroll Movie ${n}`,
        parentTitle: null,
        type: "MOVIE",
        thumbUrl: null,
        year: 2001,
        summary: null,
        contentRating: null,
        rating: null,
        ratingImage: null,
        audienceRating: null,
        audienceRatingImage: null,
        duration: 7_200_000,
        resolution: "1080",
        dynamicRange: null,
        audioProfile: null,
        audioCodec: null,
        fileSize: "1073741824",
        genres: null,
        studio: null,
        playCount: 0,
        lastPlayedAt: null,
        addedAt: "2026-01-01T00:00:00.000Z",
        matchedEpisodes: null,
        servers: [{ serverId: "srv-1", serverName: "Server", serverType: "PLEX" }],
      },
    };
  });
  return {
    ruleSet: {
      id,
      name,
      type: "MOVIE",
      seriesScope: true,
      actionType: "DELETE_RADARR",
      actionDelayDays: 7,
      addImportExclusion: false,
      searchAfterAction: false,
      addArrTags: [],
      removeArrTags: [],
      arrInstanceId: null,
      targetQualityProfileId: null,
      actionsHeldSince: null,
      scopeHoldReason: null,
      wholeSeasons: false,
    },
    items,
    count,
  };
}

/** A row of `GET /api/lifecycle/exceptions`: the exception plus its item's selected fields. */
function exception(id: string, mediaItem: Record<string, unknown> & { id: string }) {
  return {
    id,
    userId: "user-1",
    mediaItemId: mediaItem.id,
    reason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    mediaItem: {
      parentTitle: null,
      seriesKey: null,
      albumTitle: null,
      year: 2001,
      thumbUrl: null,
      summary: null,
      contentRating: null,
      rating: null,
      ratingImage: null,
      audienceRating: null,
      audienceRatingImage: null,
      duration: null,
      resolution: null,
      dynamicRange: null,
      audioProfile: null,
      fileSize: null,
      genres: null,
      studio: null,
      playCount: 0,
      seasonNumber: null,
      episodeNumber: null,
      lastPlayedAt: null,
      addedAt: null,
      library: { mediaServer: { id: "srv-1", name: "Server", type: "PLEX" } },
      ...mediaItem,
    },
  };
}

test.describe("lifecycle — exceptions grouping", () => {
  test("two different shows sharing a title are two series rows", async ({ page }) => {
    await quietEvents(page);
    const episode = (id: string, seriesKey: string, ep: number) =>
      exception(`ex-${id}`, {
        id: `mi-${id}`,
        title: `Episode ${ep}`,
        parentTitle: "The Office",
        seriesKey,
        type: "SERIES",
        seasonNumber: 1,
        episodeNumber: ep,
      });
    await page.route(isPath("/api/lifecycle/exceptions"), (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const type = new URL(route.request().url()).searchParams.get("type");
      return route.fulfill({
        json: {
          exceptions:
            type === "SERIES"
              ? [
                  // The UK show: two excepted episodes.
                  episode("uk1", "tvdb:78107", 1),
                  episode("uk2", "tvdb:78107", 2),
                  // The US show: two excepted episodes, same title.
                  episode("us1", "tvdb:73244", 1),
                  episode("us2", "tvdb:73244", 2),
                ]
              : [],
        },
      });
    });

    const moviesAsked = page.waitForRequest((req) => new URL(req.url()).searchParams.get("type") === "MOVIE");
    await page.goto("/lifecycle/exceptions");
    await moviesAsked;
    await page.getByRole("tab", { name: "Series", exact: true }).click();

    // One row per show, each with its own two episodes — not one row of four.
    await expect(page.getByText("The Office", { exact: true })).toHaveCount(2);
    await expect(page.getByText(/^4 episodes$/)).toHaveCount(0);
  });
});
