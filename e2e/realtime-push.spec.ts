import { test, expect, type Page } from "@playwright/test";
import { seedUnreachableServer, cleanupUnreachableServer, UNREACHABLE_SERVER } from "./seed";

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
  });

  /** Resolves with the first `type` event the page's own stream delivers for the server. */
  function waitForStreamEvent(page: Page, type: string, serverId: string, timeoutMs: number) {
    return page.evaluate(
      ({ type, serverId, timeoutMs }) =>
        new Promise<boolean>((resolve) => {
          const source = new EventSource("/api/events/stream");
          const timer = setTimeout(() => {
            source.close();
            resolve(false);
          }, timeoutMs);
          source.addEventListener(type, (event) => {
            const data = JSON.parse((event as MessageEvent).data) as { serverId?: string };
            if (data.serverId !== serverId) return;
            clearTimeout(timer);
            source.close();
            resolve(true);
          });
        }),
      { type, serverId, timeoutMs },
    );
  }

  test("a sync's failure, announced by the job worker, arrives on the event stream", async ({ page, baseURL }) => {
    await page.goto("/settings#servers");
    // `sync:started` is announced by the route as well; `sync:failed` only by
    // the run in the worker.
    const failed = waitForStreamEvent(page, "sync:failed", UNREACHABLE_SERVER.id, 60_000);
    // Let the stream open before the run can finish.
    await page.waitForTimeout(1_000);
    const res = await page.request.post(`/api/servers/${UNREACHABLE_SERVER.id}/sync`, {
      headers: { Origin: baseURL! },
    });
    expect(res.ok()).toBe(true);
    expect(await failed).toBe(true);
  });

  test("a server's connection state, from the realtime manager, updates Settings without a reload", async ({ page }) => {
    await page.goto("/settings#general");
    const line = page
      .getByTestId("realtime-connection-status")
      .locator("li", { hasText: UNREACHABLE_SERVER.name });
    await expect(line).toBeVisible();

    // The manager opens the socket on its next reconcile (at most a minute) and
    // the connection is refused at once.
    await expect
      .poll(
        async () => {
          const body = await (await page.request.get("/api/tools/realtime/status")).json();
          return body.servers.find((s: { serverId: string }) => s.serverId === UNREACHABLE_SERVER.id)?.status;
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe("disconnected");

    // Pushed as `server-status`, so the line turns well inside the page's 60s
    // fallback poll.
    await expect(line).toContainText("Not connected", { timeout: 10_000 });
  });
});
