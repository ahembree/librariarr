import { test, expect, type Page, type Request } from "@playwright/test";
import { seedMovieLibrary, cleanupSeed, dropAppCaches } from "./seed";
import { openDashboardInBrowser } from "./dashboard-nav";

/**
 * On a full page load the dashboard's figures are read on the server and are
 * in its HTML (`loadDashboardSeed`): a phone paints them before its script has
 * run, and the browser does not ask for them again. A client-side navigation
 * still fetches them. Runs over the seeded movie library, so the Movies tile
 * has a figure to show.
 */

/** The reads the server render answers on a full load. */
const SEEDED_READS = [
  "/api/media/stats",
  "/api/media/stats/sparklines",
  "/api/media/recently-added",
  "/api/lifecycle/summary",
  "/api/settings/schedule-info",
  "/api/sync/status",
];

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function movieTile(page: Page) {
  const library = page.locator("section", {
    has: page.getByRole("heading", { name: "Library", exact: true }),
  });
  return library.locator('a[href="/library/movies"]');
}

function seededReads(requests: Request[]): string[] {
  return requests
    .map((req) => new URL(req.url()).pathname)
    .filter((path) => SEEDED_READS.includes(path));
}

test.describe("dashboard server render", () => {
  test.beforeAll(async () => {
    await seedMovieLibrary();
  });

  // The seed went in past the app, so the stats an earlier spec cached over
  // the empty database must go first.
  test.beforeEach(async ({ page }) => {
    await dropAppCaches(page.request);
  });

  test.afterAll(async () => {
    await cleanupSeed();
  });

  test.describe("before any script runs", () => {
    test.use({ javaScriptEnabled: false });

    test("the HTML carries the library figures", async ({ page }) => {
      await page.goto("/");
      await expect(movieTile(page)).toContainText("1");
      await expect(movieTile(page).locator('[data-slot="skeleton"]')).toHaveCount(0);
      await expect(page.locator('a[href="/settings#scheduling"]', { hasText: "Next runs" })).toContainText("Detection");
    });
  });

  test.describe("on a phone", () => {
    test.use({ javaScriptEnabled: false, userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });

    test("the HTML is laid out for a phone", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Movies$/ })).toHaveCount(0);
    });
  });

  test("a client-side navigation fetches them", async ({ page }) => {
    const requests: Request[] = [];
    page.on("request", (req) => requests.push(req));
    await openDashboardInBrowser(page);
    await expect(movieTile(page)).toContainText("1");
    await expect.poll(() => seededReads(requests)).toContain("/api/media/stats");
  });

  // The stream is stubbed in both: the real one names the server's last event,
  // which anything the app did in the background (a seeded server's
  // connection failing) could set.
  test.describe("an event between the server render and the stream", () => {
    /** Answers the event stream with only its `connected` event, naming `lastEventAt`. */
    async function stubStream(page: Page, lastEventAt: () => number | null) {
      await page.route(
        (url) => url.pathname === "/api/events/stream",
        (route) =>
          route.request().method() !== "GET"
            ? route.fulfill({ status: 200 })
            : route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
                body:
                  "retry: 600000\n\n" +
                  `event: connected\ndata: ${JSON.stringify({ timestamp: Date.now(), lastEventAt: lastEventAt() })}\n\n`,
              }),
      );
    }

    test("is caught up on when the stream connects", async ({ page }) => {
      await stubStream(page, () => Date.now());
      const statsRequested = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/media/stats");
      await page.goto("/");
      await statsRequested;
    });

    test("none: a full load asks for nothing the server read", async ({ page }) => {
      await stubStream(page, () => null);
      const requests: Request[] = [];
      page.on("request", (req) => requests.push(req));
      await page.goto("/");
      await expect(page.getByRole("button", { name: /^Customize$/ })).toBeEnabled();
      await page.waitForLoadState("networkidle");
      expect(seededReads(requests)).toEqual([]);
    });
  });

  test.describe("in another time zone than the server", () => {
    /**
     * A zone whose hour, now, puts the greeting in another bucket than the
     * server's HTML did — the case that failed hydration (React #418) and made
     * React rebuild the page on the client.
     */
    async function otherZone(page: Page): Promise<string> {
      const html = await (await page.request.get("/")).text();
      const served = /Good (morning|afternoon|evening)/.exec(html)?.[1];
      expect(served).toBeTruthy();
      const bucket = (hour: number) => (hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening");
      for (const zone of ["Pacific/Kiritimati", "Asia/Tokyo", "Europe/London", "America/New_York", "Pacific/Honolulu"]) {
        const hour = Number(
          new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(new Date()),
        );
        if (bucket(hour) !== served) return zone;
      }
      throw new Error("no zone puts the greeting in another bucket");
    }

    test("the page hydrates without a mismatch and greets in the browser's time", async ({ browser, page }) => {
      const zone = await otherZone(page);
      const context = await browser.newContext({ timezoneId: zone, storageState: "e2e/.auth/admin.json" });
      const tab = await context.newPage();
      const errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      tab.on("console", (message) => {
        if (message.type() === "error" && /hydrat|#418|#423|#425/i.test(message.text())) errors.push(message.text());
      });
      await tab.goto("/");
      const hour = await tab.evaluate(() => new Date().getHours());
      const expected = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      await expect(tab.getByRole("heading", { level: 1 })).toContainText(expected);
      await expect(tab.getByRole("button", { name: /^Customize$/ })).toBeEnabled();
      expect(errors).toEqual([]);
      await context.close();
    });
  });
});
