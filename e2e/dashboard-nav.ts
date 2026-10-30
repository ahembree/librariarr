import type { Page } from "@playwright/test";

/**
 * Opens the dashboard by a client-side navigation, so its figures come from
 * the browser's own requests — which `page.route` can stub — rather than from
 * the server render. A full load of `/` reads them on the server
 * (`loadDashboardSeed`), out of the stubs' reach.
 *
 * Waits for the first page to hydrate (the shell opens the event stream from an
 * effect): a link clicked before that is a plain anchor, and the browser loads
 * `/` in full.
 */
export async function openDashboardInBrowser(page: Page): Promise<void> {
  const hydrated = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/events/stream");
  await page.goto("/system/logs");
  await hydrated;
  await page.evaluate(() => {
    (window as unknown as { __beforeDashboard?: boolean }).__beforeDashboard = true;
  });
  await page.getByRole("link", { name: /^Dashboard$/ }).first().click();
  await page.waitForURL((url) => url.pathname === "/");
  const sameDocument = await page.evaluate(
    () => (window as unknown as { __beforeDashboard?: boolean }).__beforeDashboard === true,
  );
  if (!sameDocument) throw new Error("The dashboard was loaded in full, not by a client-side navigation");
}
