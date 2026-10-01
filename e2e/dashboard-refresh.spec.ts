import { test, expect, type Page, type Request } from "@playwright/test";

/**
 * Dashboard behaviour across a realtime refresh. The page reloads its data on
 * `sync:completed` (and the other lifecycle/server events), and three things
 * went wrong there: the refresh fetched every server's stats while one server
 * was selected, it re-read the saved layout (racing an in-flight save), and a
 * deleted or disabled selection was kept, freezing the figures on a 404.
 *
 * The data routes are stubbed so the spec controls exactly which servers exist
 * and what each one's stats say, and `/api/events/stream` is held open until
 * the test releases one `sync:completed` event — the same event a real sync
 * delivers.
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
  /** Deliver one `sync:completed` event and wait for the page to refetch. */
  fireSyncCompleted: () => Promise<void>;
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
  let releaseStream: (() => void) | null = null;

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
  // Held open until the test releases it; `retry` keeps the browser from
  // reconnecting (and resyncing every subscriber) for the rest of the test.
  await page.route(isPath("/api/events/stream"), async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200 });
    await new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body:
        "retry: 600000\n\n" +
        "event: connected\ndata: {}\n\n" +
        `event: sync:completed\ndata: ${JSON.stringify({ type: "sync:completed", timestamp: Date.now() })}\n\n`,
    });
  });

  return {
    statsRequests,
    layoutGets: () => layoutGets,
    setServers: (list) => {
      servers = list;
    },
    setTypes: (list) => {
      types = list;
    },
    fireSyncCompleted: async () => {
      await expect.poll(() => releaseStream !== null).toBe(true);
      const refetched = page.waitForResponse(
        (res) => new URL(res.url()).pathname === "/api/servers",
      );
      releaseStream!();
      await refetched;
    },
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

  test("a refresh does not re-read the saved layout", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/");
    await expect(movieTile(page)).toContainText(String(ALL_MOVIES));
    expect(h.layoutGets()).toBe(1);

    await h.fireSyncCompleted();

    expect(h.layoutGets()).toBe(1);
  });

  test("a deleted selection falls back to all servers", async ({ page }) => {
    const h = await setup(page);
    await page.goto("/");
    await selectServer(page, "Alpha");
    await expect(movieTile(page)).toContainText(String(SERVER_A_MOVIES));

    h.setServers([server("srv-b", "Bravo", true), server("srv-c", "Charlie", true)]);
    const before = h.statsRequests.length;
    await h.fireSyncCompleted();

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

  test("a type filter whose type has gone falls back to all types", async ({ page }) => {
    const h = await setup(page);
    h.setTypes(["MOVIE", "SERIES"]);
    // One custom timeline card, binned by year so its requests are told apart
    // from the library tiles' monthly sparklines; it sends the Insights filter
    // as `type`. Registered after setup(), so it takes precedence.
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
    await page.route(isPath("/api/settings/dashboard-layout"), (route) =>
      route.fulfill({ json: { layout } }),
    );
    const cardTypes: (string | null)[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.pathname === "/api/media/stats/timeline" && url.searchParams.get("bin") === "year") {
        cardTypes.push(url.searchParams.get("type"));
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
    const shelfItem = (id: string) => ({
      id,
      groupKey: "movie:group-1",
      title: "Arrival",
      year: 2016,
      type: "MOVIE",
      parentTitle: null,
      albumTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      addedAt: new Date().toISOString(),
      thumbUrl: null,
      parentThumbUrl: null,
      seasonThumbUrl: null,
      memberCount: 1,
    });
    let representative = "old-item";
    await page.route(isPath("/api/media/recently-added"), (route) =>
      route.fulfill({ json: { items: [shelfItem(representative)], total: 1 } }),
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
    const tile = page.getByRole("button", { name: "Arrival (2016)" });
    await expect(tile).toBeVisible();
    // The old row's art 404s: the tile falls back to the icon.
    await expect(tile.locator("img")).toHaveCount(0);

    representative = "new-item";
    await h.fireSyncCompleted();

    await expect(tile.locator('img[src*="/api/media/new-item/image"]')).toHaveCount(1);
  });
});
