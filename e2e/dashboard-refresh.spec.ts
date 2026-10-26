import { test, expect, type Page, type Request } from "@playwright/test";
import { storeDashboardLayout } from "./seed";

/**
 * Dashboard behaviour across a realtime refresh. The page reloads its data on
 * `sync:completed` (and the other lifecycle/server events), and three things
 * went wrong there: the refresh fetched every server's stats while one server
 * was selected, it re-read the saved layout (racing an in-flight save), and a
 * deleted or disabled selection was kept, freezing the figures on a 404.
 *
 * The data routes are stubbed so the spec controls exactly which servers exist
 * and what each one's stats say, and `/api/events/stream` is held open until
 * the test releases one event — `sync:completed` as a real sync delivers it,
 * or `server:changed` as every server add, edit, disable and delete does.
 */

const ALL_MOVIES = 111;
const SERVER_A_MOVIES = 7;

function statsBody(movieCount: number) {
  return {
    movieCount,
    seriesCount: 0,
    seasonCount: 0,
    musicCount: 0,
    artistCount: 0,
    albumCount: 0,
    episodeCount: 0,
    totalSize: "0",
    movieSize: "0",
    seriesSize: "0",
    musicSize: "0",
    movieDuration: 0,
    seriesDuration: 0,
    musicDuration: 0,
    qualityBreakdown: [],
    topMovies: [],
    topSeries: [],
    topMusic: [],
    videoCodecBreakdown: [],
    audioCodecBreakdown: [],
    contentRatingBreakdown: [],
    dynamicRangeBreakdown: [],
    audioChannelsBreakdown: [],
    genreBreakdown: [],
  };
}

function server(id: string, name: string, enabled: boolean) {
  return { id, name, type: "PLEX", enabled, libraries: [], syncJobs: [] };
}

let restoreLayout: (() => Promise<void>) | undefined;

test.afterEach(async () => {
  await restoreLayout?.();
  restoreLayout = undefined;
});

const isStats = (url: string) => new URL(url).pathname === "/api/media/stats";
const isPath = (path: string) => (url: URL) => url.pathname === path;

interface Harness {
  /** Every stats request the page made, in order. */
  statsRequests: Request[];
  /** GETs of the saved dashboard layout. */
  layoutGets: () => number;
  /** Servers `/api/servers` reports from now on. */
  setServers: (list: ReturnType<typeof server>[]) => void;
  /** Library types `/api/media/library-types` reports from now on. */
  setTypes: (types: string[]) => void;
  /** Deliver one `sync:completed` event and wait for the page to refetch its stats. */
  fireSyncCompleted: () => Promise<void>;
  /** Deliver one `server:changed` event and wait for the page to re-read the servers. */
  fireServerChanged: () => Promise<void>;
}

async function setup(page: Page): Promise<Harness> {
  let servers = [
    server("srv-a", "Alpha", true),
    server("srv-b", "Bravo", true),
    server("srv-off", "Disabled Box", false),
  ];
  let types = ["MOVIE"];
  let layoutGets = 0;
  const statsRequests: Request[] = [];
  let releaseStream: ((event: string) => void) | null = null;

  await page.route(isPath("/api/servers"), (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { servers } })
      : route.continue(),
  );
  await page.route(isPath("/api/media/library-types"), (route) =>
    route.fulfill({ json: { types, allTypes: types } }),
  );
  await page.route(
    (url) => isStats(url.toString()),
    (route) => {
      statsRequests.push(route.request());
      const serverId = new URL(route.request().url()).searchParams.get("serverId");
      if (serverId && !servers.some((s) => s.id === serverId && s.enabled)) {
        return route.fulfill({ status: 404, json: { error: "Server not found" } });
      }
      return route.fulfill({
        json: statsBody(serverId === "srv-a" ? SERVER_A_MOVIES : ALL_MOVIES),
      });
    },
  );
  await page.route(isPath("/api/settings/dashboard-layout"), (route) => {
    if (route.request().method() === "GET") layoutGets++;
    return route.continue();
  });
  // Held open until the test releases it with one event; `retry` keeps the
  // browser from reconnecting (and resyncing every subscriber) for the rest of
  // the test.
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
        // The route's own framing: the event name, then `{ timestamp, ...meta }`.
        `event: ${event}\ndata: ${JSON.stringify({ timestamp: Date.now(), serverId: "srv-b" })}\n\n`,
    });
  });

  const fire = async (event: string, refetched: (url: URL) => boolean) => {
    await expect.poll(() => releaseStream !== null).toBe(true);
    const response = page.waitForResponse((res) => refetched(new URL(res.url())));
    releaseStream!(event);
    await response;
  };

  return {
    statsRequests,
    layoutGets: () => layoutGets,
    setServers: (list) => {
      servers = list;
    },
    setTypes: (list) => {
      types = list;
    },
    // A sync moves the figures; the server list is `server:changed`'s.
    fireSyncCompleted: () => fire("sync:completed", (url) => url.pathname === "/api/media/stats"),
    // Every route that adds, edits, disables or deletes a server emits it.
    fireServerChanged: () => fire("server:changed", (url) => url.pathname === "/api/servers"),
  };
}

function movieTile(page: Page) {
  const library = page.locator("section", {
    has: page.getByRole("heading", { name: "Library", exact: true }),
  });
  return library.locator('a[href="/library/movies"]');
}

async function selectServer(page: Page, name: string) {
  // The dashboard's selector is the first one reading "All Servers"; Recently
  // Added carries its own further down.
  await page.getByRole("combobox").filter({ hasText: "All Servers" }).first().click();
  await page.getByRole("option", { name, exact: true }).click();
}

test.describe("dashboard refresh", () => {
  test("does not offer a disabled server", async ({ page }) => {
    await setup(page);
    await page.goto("/");
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));

    await page.getByRole("combobox").filter({ hasText: "All Servers" }).first().click();
    await expect(page.getByRole("option", { name: "Alpha", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Disabled Box" })).toHaveCount(0);
    await expect(page.getByText(/· 2 servers/)).toBeVisible();
  });

  test("a refresh keeps the selected server's stats", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/");
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));

    await selectServer(page, "Alpha");
    await expect(movieTile(page)).toContainText(String(SERVER_A_MOVIES));
    const before = h.statsRequests.length;

    await h.fireSyncCompleted();

    await expect.poll(() => h.statsRequests.length).toBeGreaterThan(before);
    for (const req of h.statsRequests.slice(before)) {
      expect(new URL(req.url()).searchParams.get("serverId")).toBe("srv-a");
    }
    await expect(movieTile(page)).toContainText(String(SERVER_A_MOVIES));
  });

  test("the end of a sync asks for the stats once", async ({ page }) => {
    const h = await setup(page);
    let finished = false;
    const job = () => ({
      id: "job-1",
      mediaServerId: "srv-b",
      status: finished ? "COMPLETED" : "RUNNING",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: finished ? new Date().toISOString() : null,
      error: null,
      itemsProcessed: 5,
      totalItems: 10,
      currentLibrary: null,
      mediaServer: { name: "Bravo", type: "PLEX" },
    });
    await page.route(isPath("/api/sync/status"), (route) => route.fulfill({ json: { jobs: [job()] } }));
    await page.goto("/");
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));
    await expect(page.getByText(/Syncing Bravo/)).toBeVisible();
    const before = h.statsRequests.length;

    finished = true;
    await h.fireSyncCompleted();
    // The indicator has seen the sync end by the time it announces it. It used
    // to refresh the stats itself there, beside the page's own refetch.
    await expect(page.getByText("Sync complete: Bravo")).toBeVisible();
    expect(h.statsRequests.length - before).toBe(1);
  });

  test("a refresh does not re-read the saved layout", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/");
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));
    // The saved layout comes with the server render; the page never asks.
    expect(h.layoutGets()).toBe(0);

    await h.fireSyncCompleted();

    expect(h.layoutGets()).toBe(0);
  });

  test("a visit after a client-side navigation reads the library types again", async ({ page }) => {
    const h = await setup(page);
    // The layout read none (the e2e database has no libraries), which the
    // dashboard reads as every tile. Since then only Series is left.
    h.setTypes(["SERIES"]);
    await page.goto("/system/logs");
    await page.getByRole("link", { name: /^Dashboard$/ }).first().click();
    await page.waitForURL((url) => url.pathname === "/");

    const library = page.locator("section", {
      has: page.getByRole("heading", { name: "Library", exact: true }),
    });
    await expect(library.locator('a[href="/library/series"]')).toBeVisible();
    await expect(movieTile(page)).toHaveCount(0);
  });

  test("a deleted selection falls back to all servers", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/");
    await selectServer(page, "Alpha");
    await expect(movieTile(page)).toContainText(String(SERVER_A_MOVIES));

    h.setServers([server("srv-b", "Bravo", true), server("srv-c", "Charlie", true)]);
    const before = h.statsRequests.length;
    await h.fireServerChanged();

    await expect(
      page.getByRole("combobox").filter({ hasText: "All Servers" }).first(),
    ).toBeVisible();
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));
    await expect
      .poll(() =>
        h.statsRequests
          .slice(before)
          .some((req) => !new URL(req.url()).searchParams.has("serverId")),
      )
      .toBe(true);
  });

  test("a server picked during the first stats load shows that server, not a failure", async ({ page }) => {
    await setup(page);
    // Records whether the failure state was EVER rendered, however briefly.
    await page.addInitScript(() => {
      const w = window as unknown as { __sawDashboardFailure: boolean };
      w.__sawDashboardFailure = false;
      new MutationObserver(() => {
        if (document.body?.textContent?.includes("Failed to load dashboard")) w.__sawDashboardFailure = true;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    // Hold the first (all-servers) stats request and the picked server's one,
    // so the first can be answered — and dropped as stale — while the second
    // is still in flight. Registered after setup(), so it takes precedence;
    // anything else falls through to setup's stub.
    const held: Record<string, () => void> = {};
    await page.route(
      (url) => isStats(url.toString()),
      async (route) => {
        const key = new URL(route.request().url()).searchParams.get("serverId") ?? "all";
        if (key in held || !["all", "srv-a"].includes(key)) return route.fallback();
        await new Promise<void>((resolve) => {
          held[key] = resolve;
        });
        return route.fallback();
      },
    );

    await page.goto("/");
    await expect.poll(() => "all" in held).toBe(true);
    await selectServer(page, "Alpha");
    await expect.poll(() => "srv-a" in held).toBe(true);

    const firstAnswered = page.waitForResponse(
      (res) => isStats(res.url()) && !new URL(res.url()).searchParams.has("serverId"),
    );
    held.all();
    await firstAnswered;
    // Wait until every other first-load request has been applied — the saved
    // layout and library types (Customize enabled) and the schedule info (the
    // Next runs tile filled in) — which is when the page used to read
    // "settled with no stats" as a failure and replace the dashboard.
    await expect(page.getByRole("button", { name: /^Customize$/ })).toBeEnabled();
    await expect(page.locator('a[href="/settings#scheduling"]', { hasText: "Next runs" })).toContainText("Detection");
    await expect(page.getByText("Failed to load dashboard")).toHaveCount(0);

    held["srv-a"]();
    await expect(movieTile(page)).toContainText(String(SERVER_A_MOVIES));
    // Not even for a moment while the picked server's stats were in flight.
    expect(await page.evaluate(() => (window as unknown as { __sawDashboardFailure: boolean }).__sawDashboardFailure)).toBe(false);
  });

  test("a type filter whose type has gone falls back to all types", async ({ page }) => {
    const h = await setup(page);
    h.setTypes(["MOVIE", "SERIES"]);
    // One custom timeline card, binned by year so its requests are told apart
    // from the library tiles' monthly sparklines; it sends the Insights filter
    // as `type`. Stored, not stubbed: the layout comes with the server render.
    const layout = {
      main: [
        {
          id: "custom-e2e-timeline",
          size: 12,
          config: { chartType: "timeline", dimension: "addedAt", timelineBin: "year" },
        },
      ],
      movies: [],
      series: [],
      music: [],
    };
    restoreLayout = await storeDashboardLayout(layout);
    // Every custom card's data comes in one batch request; this card's entry
    // is the timeline binned by year.
    const cardTypes: (string | null)[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname !== "/api/media/stats/custom-batch") return;
      const { cards } = req.postDataJSON() as { cards: { kind: string; bin?: string; type?: string }[] };
      for (const card of cards) {
        if (card.kind === "timeline" && card.bin === "year") cardTypes.push(card.type ?? null);
      }
    });

    await page.goto("/");
    // Recently Added has its own "All Types" selector above this one.
    const insights = page.locator("section", {
      has: page.getByRole("heading", { name: "Insights", exact: true }),
    });
    await insights.getByRole("combobox").filter({ hasText: "All Types" }).click();
    await page.getByRole("option", { name: "Movies", exact: true }).click();
    await expect.poll(() => cardTypes.at(-1)).toBe("MOVIE");

    // Movies leave the library: the selector hides itself (one type left),
    // so the filter must not stay on MOVIE with no way to clear it.
    h.setTypes(["SERIES"]);
    await h.fireSyncCompleted();

    await expect.poll(() => cardTypes.at(-1)).toBeNull();
  });

  test("a shelf tile retries artwork when a newer item takes it over", async ({ page }) => {
    const h = await setup(page);
    // A season tile: the route keys it by show and season, and its
    // representative is one of the season's episodes — the newest arrival
    // takes that over while the tile (keyed by `groupKey`) stays. A movie
    // cannot: its group key is `item:<id>`, so a new id is a new tile.
    const shelfItem = (id: string, episodeNumber: number) => ({
      groupKey: "series:tvdb:305288::1",
      memberCount: episodeNumber,
      addedAt: new Date().toISOString(),
      id,
      title: `Chapter ${episodeNumber}`,
      year: 2016,
      type: "SERIES",
      parentTitle: "Stranger Things",
      albumTitle: null,
      seasonNumber: 1,
      episodeNumber,
      thumbUrl: `/library/metadata/${id}/thumb/1700000000`,
      parentThumbUrl: "/library/metadata/1000/thumb/1700000000",
      seasonThumbUrl: "/library/metadata/1001/thumb/1700000000",
      groupTotal: 1,
    });
    let representative = shelfItem("old-item", 2);
    await page.route(isPath("/api/media/recently-added"), (route) =>
      route.fulfill({ json: { items: [representative], total: 1 } }),
    );
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await page.route(
      (url) => /^\/api\/media\/[^/]+\/image$/.test(url.pathname),
      (route) =>
        new URL(route.request().url()).pathname.startsWith("/api/media/old-item/")
          ? route.fulfill({ status: 404, body: "" })
          : route.fulfill({ status: 200, contentType: "image/png", body: png }),
    );

    await page.goto("/");
    const tile = page.getByRole("button", { name: /^Stranger Things — Season 1 \(\d+ episodes\)$/ });
    await expect(tile).toContainText("2 episodes");
    // The old row's season art and its series fallback both 404: the tile
    // falls back to the icon.
    await expect(tile.locator("img")).toHaveCount(0);

    representative = shelfItem("new-item", 3);
    await h.fireSyncCompleted();

    await expect(tile).toContainText("3 episodes");
    await expect(tile.locator('img[src*="/api/media/new-item/image?type=season"]')).toHaveCount(1);
  });
});
