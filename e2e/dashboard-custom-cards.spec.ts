import { test, expect, type Page, type Route } from "@playwright/test";
import { storeDashboardLayout } from "./seed";

/**
 * Custom Insights cards. The saved layout is stored for each test and restored
 * after it (and saves are swallowed), so each test starts from a known grid
 * and nothing it adds leaks into the shared e2e database the other specs read.
 *
 * Covers: the dialog only offering combinations the routes accept (a timeline
 * "Color By" the route can express, a heatmap pair the cross-tab can cross),
 * every card's data arriving in one batch request, and a card whose data
 * fails to load showing an error rather than "No data" or the previous
 * config's data under its new title.
 */

type Layout = { main: unknown[]; movies: unknown[]; series: unknown[]; music: unknown[] };

let restoreLayout: (() => Promise<void>) | undefined;

test.afterEach(async () => {
  await restoreLayout?.();
  restoreLayout = undefined;
});

// The saved layout comes with the server render, so it is stored for the
// test; the saves the test makes are swallowed.
async function stubLayout(page: Page, main: unknown[]) {
  const layout: Layout = { main, movies: [], series: [], music: [] };
  restoreLayout = await storeDashboardLayout(layout);
  await page.route(
    (url) => url.pathname === "/api/settings/dashboard-layout",
    (route: Route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { layout } })
        : route.fulfill({ json: { layout: route.request().postDataJSON()?.layout ?? layout } }),
  );
}

type BatchCard = { kind: "timeline" | "crossTab" | "custom"; [key: string]: unknown };

/**
 * Every custom card's data comes from one `POST /api/media/stats/custom-batch`
 * (`{ cards }` → `{ cards: [{ status, body }] }`, in order); `answer` gives
 * each card's entry, as its own route would have answered it.
 */
async function stubCardData(page: Page, answer: (card: BatchCard) => { status: number; body: unknown }) {
  await page.route(
    (url) => url.pathname === "/api/media/stats/custom-batch",
    (route: Route) => {
      const { cards } = route.request().postDataJSON() as { cards: BatchCard[] };
      return route.fulfill({ json: { cards: cards.map(answer) } });
    },
  );
}

async function openCustomCardDialog(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^Customize$/ }).click();
  await page.getByRole("button", { name: /Add Card/ }).click();
  await page.getByRole("menuitem", { name: /Custom Card/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Add Custom Card")).toBeVisible();
  return dialog;
}

test.describe("dashboard custom cards", () => {
  test("a timeline only offers breakdowns it can colour by", async ({ page }) => {
    await stubLayout(page, []);
    const dialog = await openCustomCardDialog(page);

    await dialog.getByRole("button", { name: "Timeline" }).click();
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Added Date" }).click();

    // Date field, time interval, then Color By.
    await dialog.getByRole("combobox").nth(2).click();
    await expect(page.getByRole("option", { name: "Resolution", exact: true })).toBeVisible();
    for (const name of ["Genre", "Countries", "Audio Language", "Subtitle Language", "Last Played"]) {
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
    }
  });

  test("a heatmap does not offer a second stream dimension", async ({ page }) => {
    await stubLayout(page, []);
    const dialog = await openCustomCardDialog(page);

    await dialog.getByRole("button", { name: "Heatmap" }).click();
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Audio Language", exact: true }).click();

    await dialog.getByRole("combobox").nth(1).click();
    await expect(page.getByRole("option", { name: "Resolution", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Subtitle Language", exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Audio Language", exact: true })).toHaveCount(0);
  });

  test("every custom card's data comes in one request", async ({ page }) => {
    await stubLayout(page, [
      { id: "custom-e2e-heatmap", size: 4, config: { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" } },
      { id: "custom-e2e-timeline", size: 4, config: { chartType: "timeline", dimension: "addedAt", timelineBin: "year" } },
      { id: "custom-e2e-pie", size: 4, config: { chartType: "pie", dimension: "genre" } },
    ]);
    const batches: BatchCard["kind"][][] = [];
    let ownRoutes = 0;
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path === "/api/media/stats/custom-batch") {
        batches.push((req.postDataJSON() as { cards: BatchCard[] }).cards.map((c) => c.kind));
      } else if (["/api/media/stats/timeline", "/api/media/stats/cross-tab", "/api/media/stats/custom"].includes(path)) {
        ownRoutes++;
      }
    });
    await page.goto("/");

    for (const title of ["Resolution vs Video Codec", "Added Date Timeline", "Genre Breakdown"]) {
      await expect(page.getByText(title)).toBeVisible();
    }
    await expect.poll(() => batches.length).toBe(1);
    expect([...batches[0]].sort()).toEqual(["crossTab", "custom", "timeline"]);
    expect(ownRoutes).toBe(0);
  });

  test("a card whose data fails to load says so", async ({ page }) => {
    await stubLayout(page, [
      {
        id: "custom-e2e-heatmap",
        size: 12,
        config: { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" },
      },
    ]);
    // The batch answers; the card's own entry is the cross-tab's failure.
    await stubCardData(page, (card) =>
      card.kind === "crossTab" ? { status: 500, body: { error: "boom" } } : { status: 200, body: {} },
    );
    await page.goto("/");

    await expect(page.getByText("Resolution vs Video Codec")).toBeVisible();
    await expect(page.getByText("Couldn't load this chart")).toBeVisible();
    await expect(page.getByText("No data available")).toHaveCount(0);
  });

  test("an edit that fails to load does not keep the old data under the new title", async ({ page }) => {
    await stubLayout(page, [
      {
        id: "custom-e2e-heatmap",
        size: 12,
        config: { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" },
      },
    ]);
    let calls = 0;
    await stubCardData(page, (card) => {
      if (card.kind !== "crossTab") return { status: 200, body: {} };
      calls++;
      // Resolution comes back as its display bin, as `computeCrossTab` maps it.
      return calls === 1
        ? { status: 200, body: { rows: [{ dim1: "1080P", dim2: "h264", type: "MOVIE", _count: 42 }] } }
        : { status: 500, body: { error: "boom" } };
    });
    await page.goto("/");
    const card = page.locator('[data-slot="card"]', { hasText: "custom chart" });
    await expect(card.getByText("Resolution vs Video Codec")).toBeVisible();
    // The first load drew the heatmap (its gradient legend renders only with cells).
    await expect(card.getByText("High", { exact: true })).toBeVisible();
    await expect(card.getByText("Couldn't load this chart")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit chart settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Audio Codec", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(card.getByText("Resolution vs Audio Codec")).toBeVisible();
    await expect(card.getByText("Couldn't load this chart")).toBeVisible();
    // …and the previous config's heatmap is gone with it.
    await expect(card.getByText("High", { exact: true })).toHaveCount(0);
    expect(calls).toBe(2);
  });
});
