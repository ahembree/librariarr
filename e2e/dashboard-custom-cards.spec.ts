import { test, expect, type Page, type Route } from "@playwright/test";
import { storeDashboardLayout } from "./seed";

/**
 * Custom Insights cards. The saved layout is stored for each test and restored
 * after it (and saves are swallowed), so each test starts from a known grid
 * and nothing it adds leaks into the shared e2e database the other specs read.
 *
 * Covers: the dialog only offering combinations the routes accept (a timeline
 * "Color By" the route can express, a heatmap pair the cross-tab can cross),
 * every card's data arriving in one batch request, the dialog previewing the
 * card it is configuring, and a card whose data fails to load showing an
 * error rather than "No data" or the previous config's data under its new
 * title.
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

  test("the dialog previews the card before it is added", async ({ page }) => {
    await stubLayout(page, []);
    await stubCardData(page, (card) =>
      card.kind === "custom" && card.dimension === "resolution"
        ? { status: 200, body: { breakdown: [{ value: "4K", type: "MOVIE", _count: 7 }, { value: "1080P", type: "MOVIE", _count: 31 }] } }
        : { status: 200, body: {} },
    );
    const dialog = await openCustomCardDialog(page);
    await expect(dialog.getByText("Choose a dimension to see a preview.")).toBeVisible();

    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Resolution", exact: true }).click();

    await expect(dialog.getByText("Resolution Breakdown")).toBeVisible();
    await expect(dialog.getByText("1080P (31)")).toBeVisible();
    await expect(dialog.getByText("4K (7)")).toBeVisible();

    // Presentation options redraw the preview without asking again.
    await dialog.getByPlaceholder("Auto-generated from dimension").fill("My Resolutions");
    await expect(dialog.getByText("My Resolutions")).toBeVisible();
  });

  test("an edit that fails to load does not keep the old data under the new title", async ({ page }) => {
    await stubLayout(page, [
      {
        id: "custom-e2e-heatmap",
        size: 12,
        config: { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" },
      },
    ]);
    // The saved config loads; the edited one fails — in the dialog's preview
    // and on the card once saved.
    await stubCardData(page, (card) => {
      if (card.kind !== "crossTab") return { status: 200, body: {} };
      // Resolution comes back as its display bin, as `computeCrossTab` maps it.
      return card.dimension2 === "videoCodec"
        ? { status: 200, body: { rows: [{ dim1: "1080P", dim2: "h264", type: "MOVIE", _count: 42 }] } }
        : { status: 500, body: { error: "boom" } };
    });
    await page.goto("/");
    // The grid's card, not the dialog's preview (the dialog portals outside <main>).
    const card = page.locator("main").locator('[data-slot="card"]', { hasText: "custom chart" });
    await expect(card.getByText("Resolution vs Video Codec")).toBeVisible();
    // The first load drew the heatmap (its gradient legend renders only with cells).
    await expect(card.getByText("High", { exact: true })).toBeVisible();
    await expect(card.getByText("Couldn't load this chart")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit chart settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Audio Codec", exact: true }).click();
    await expect(dialog.getByText("Couldn't load this chart")).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(card.getByText("Resolution vs Audio Codec")).toBeVisible();
    await expect(card.getByText("Couldn't load this chart")).toBeVisible();
    // …and the previous config's heatmap is gone with it.
    await expect(card.getByText("High", { exact: true })).toHaveCount(0);
  });
});
