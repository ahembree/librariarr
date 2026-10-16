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
      body: "retry: 600000\n\nevent: connected\ndata: {}\n\n",
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
      // Detection's result rows: the same rule set without the page-only fields.
      await page.route(isPath("/api/lifecycle/rules/run"), (route) => {
        const detectionRow = ruleSet();
        delete (detectionRow as Record<string, unknown>).collectionName;
        return route.fulfill({
          json: { success: true, ruleMatches: [{ ruleSet: detectionRow, items: [], count: 0 }], skipped: [] },
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
      if (ruleSetId !== "rs-b") return route.fulfill({ json: { success: true, ruleMatches: [], skipped: [] } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      bReturned = true;
      await route.fulfill({ json: { success: true, ruleMatches: [], skipped: [] } });
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
    await page.waitForTimeout(500);
    await expect(page.getByText("Stale Movie Title")).toHaveCount(0);
    await expect(page.getByText(/no exceptions/i)).toBeVisible();
  });
});

function exception(id: string, mediaItem: Record<string, unknown>) {
  return {
    id,
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
