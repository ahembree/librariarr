import { test, expect } from "@playwright/test";

/**
 * `/login/reauth` is where the SSO identity-confirmation popup lands. It
 * reports the outcome on the `librariarr-reauth` BroadcastChannel (and to its
 * opener) with the nonce it was given, then tries to close itself; a window the
 * browser will not close shows the outcome instead.
 */
const CHANNEL = "librariarr-reauth";
const TYPE = "librariarr:reauth";

async function listen(page: import("@playwright/test").Page) {
  await page.goto("/login/reauth?pending=1");
  await page.evaluate((channel) => {
    const w = window as unknown as { __reports: unknown[] };
    w.__reports = [];
    const bc = new BroadcastChannel(channel);
    bc.onmessage = (e) => w.__reports.push(e.data);
  }, CHANNEL);
}

test.describe("reauth popup landing page", () => {
  test("reports success with its nonce on the broadcast channel", async ({ page, context }) => {
    await listen(page);
    const popup = await context.newPage();
    await popup.goto("/login/reauth?status=ok&nonce=n-123");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reports: unknown[] }).__reports))
      .toEqual([{ type: TYPE, ok: true, nonce: "n-123" }]);
    // Not script-opened, so the browser keeps it open and it says what happened.
    await expect(popup.getByText(/Identity confirmed/i)).toBeVisible();
  });

  test("reports a failure with its error code", async ({ page, context }) => {
    await listen(page);
    const popup = await context.newPage();
    await popup.goto("/login/reauth?error=session_lost&nonce=n-9");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reports: unknown[] }).__reports))
      .toEqual([{ type: TYPE, ok: false, error: "session_lost", nonce: "n-9" }]);
    await expect(popup.getByText(/Couldn't confirm it's you/i)).toBeVisible();
  });

  test("reports nothing while the sign-in is still being started", async ({ page, context }) => {
    await listen(page);
    const popup = await context.newPage();
    await popup.goto("/login/reauth?pending=1");
    await expect(popup.getByText(/Connecting to your sign-in provider/i)).toBeVisible();
    // The pending text is also what the server renders, so it does not show the
    // page has run; wait for the page to go quiet, then let a second popup
    // report. The listener hearing that one, and only that one, shows it works
    // and that the pending page sent nothing.
    await popup.waitForLoadState("networkidle");
    const sentinel = await context.newPage();
    await sentinel.goto("/login/reauth?status=ok&nonce=after-pending");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reports: unknown[] }).__reports))
      .toEqual([{ type: TYPE, ok: true, nonce: "after-pending" }]);
  });

  test("a script-opened popup reports to its opener and closes itself", async ({ page }) => {
    await page.goto("/login/reauth?pending=1");
    await page.evaluate((type) => {
      const w = window as unknown as { __opener: unknown[] };
      w.__opener = [];
      window.addEventListener("message", (e) => {
        if ((e.data as { type?: string })?.type === type) w.__opener.push(e.data);
      });
    }, TYPE);

    const popupPromise = page.waitForEvent("popup");
    await page.evaluate(() => window.open("/login/reauth?status=ok&nonce=opener-1", "reauth"));
    const popup = await popupPromise;
    // Polled rather than awaited as an event: the page may close itself before
    // a `close` listener could be attached.
    await expect.poll(() => popup.isClosed()).toBe(true);

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opener: unknown[] }).__opener))
      .toEqual([{ type: TYPE, ok: true, nonce: "opener-1" }]);
  });
});
