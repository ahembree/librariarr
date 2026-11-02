import { test, expect, type Page } from "@playwright/test";
import { seedUnreachableServer, cleanupUnreachableServer, UNREACHABLE_SERVER } from "./seed";

/** Added mid-test, so the manager's first state for it can only reach the page as a push. */
const LATE_SERVER = { id: "e2e-unreachable-server-late", name: "E2E Late Server" } as const;

/**
 * Work the job worker and the realtime manager do must reach the browser.
 *
 * Both are started from instrumentation, which in a production build loads its
 * own copy of every module, while `/api/events/stream` runs in a route bundle.
 * A singleton the two sides share has to be pinned to globalThis; `eventBus`
 * was pinned only in development, so in production nothing the worker or the
 * manager emitted reached any page. Every Vitest suite runs one module graph
 * and every other spec stubs the stream, so this suite — run against the real
 * production image in CI — is the only place that failure shows.
 */
test.describe("events from background work reach the page", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    await seedUnreachableServer();
  });

  test.afterAll(async () => {
    await cleanupUnreachableServer();
    await cleanupUnreachableServer(LATE_SERVER);
  });

  /**
   * Opens a stream of the page's own and returns once it is subscribed — the
   * route subscribes to the event bus before it sends `connected`. The
   * returned function resolves with whether a `type` event for the server
   * arrived within `timeoutMs`.
   */
  async function listenForStreamEvent(page: Page, type: string, serverId: string, timeoutMs: number) {
    await page.evaluate(
      ({ type, serverId, timeoutMs }) =>
        new Promise<void>((subscribed) => {
          const source = new EventSource("/api/events/stream");
          (window as unknown as { __streamEvent: Promise<boolean> }).__streamEvent = new Promise<boolean>((resolve) => {
            const finish = (seen: boolean) => {
              clearTimeout(timer);
              source.close();
              subscribed();
              resolve(seen);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            source.addEventListener("connected", () => subscribed(), { once: true });
            source.addEventListener(type, (event) => {
              const data = JSON.parse((event as MessageEvent).data) as { serverId?: string };
              if (data.serverId === serverId) finish(true);
            });
          });
        }),
      { type, serverId, timeoutMs },
    );
    return () => page.evaluate(() => (window as unknown as { __streamEvent: Promise<boolean> }).__streamEvent);
  }

  test("a sync's failure, announced by the job worker, arrives on the event stream", async ({ page, baseURL }) => {
    await page.goto("/settings#servers");
    // `sync:started` is announced by the route as well; `sync:failed` only by
    // the run in the worker.
    // Subscribed before the sync is requested, so the run cannot finish first.
    const failed = await listenForStreamEvent(page, "sync:failed", UNREACHABLE_SERVER.id, 60_000);
    const res = await page.request.post(`/api/servers/${UNREACHABLE_SERVER.id}/sync`, {
      headers: { Origin: baseURL! },
    });
    expect(res.ok()).toBe(true);
    expect(await failed()).toBe(true);
  });

  test("a server's connection state, from the realtime manager, reaches the page and its Settings line", async ({ page }) => {
    await page.goto("/settings#general");
    await expect(page.getByTestId("realtime-connection-status")).toBeVisible();

    // Listen BEFORE the server exists. The manager picks it up on its next
    // reconcile (at most a minute) and the connection is refused at once, so
    // its first `server-status` can only arrive over the stream — the page's
    // 60s fallback poll cannot stand in for a lost push here.
    const pushed = await listenForStreamEvent(page, "server-status", LATE_SERVER.id, 100_000);
    await seedUnreachableServer(LATE_SERVER);
    expect(await pushed()).toBe(true);

    // The page refetches on that same push.
    await expect(
      page.getByTestId("realtime-connection-status").locator("li", { hasText: LATE_SERVER.name }),
    ).toContainText("Not connected", { timeout: 10_000 });
  });
});
