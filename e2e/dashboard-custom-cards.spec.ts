import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Custom Insights cards. The saved layout is stubbed (and saves are swallowed)
 * so each test starts from a known grid and nothing it adds leaks into the
 * shared e2e database the other specs read.
 *
 * Covers: the dialog only offering combinations the routes accept (a timeline
 * "Color By" the route can express, a heatmap pair the cross-tab can cross),
 * and a card whose data fails to load showing an error rather than "No data"
 * or the previous config's data under its new title.
 */

type Layout = { main: unknown[]; movies: unknown[]; series: unknown[]; music: unknown[] };

async function stubLayout(page: Page, main: unknown[]) {
  const layout: Layout = { main, movies: [], series: [], music: [] };
  await page.route(
    (url) => url.pathname === "/api/settings/dashboard-layout",
    (route: Route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { layout } })
        : route.fulfill({ json: { layout: route.request().postDataJSON()?.layout ?? layout } }),
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

  test("a card whose data fails to load says so", async ({ page }) => {
    await stubLayout(page, [
      {
        id: "custom-e2e-heatmap",
        size: 12,
        config: { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" },
      },
    ]);
    await page.route(
      (url) => url.pathname === "/api/media/stats/cross-tab",
      (route) => route.fulfill({ status: 500, json: { error: "boom" } }),
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
    await page.route(
      (url) => url.pathname === "/api/media/stats/cross-tab",
      (route) => {
        calls++;
        return calls === 1
          ? route.fulfill({
              json: { rows: [{ dim1: "1080", dim2: "h264", type: "MOVIE", _count: 42 }] },
            })
          : route.fulfill({ status: 500, json: { error: "boom" } });
      },
    );
    await page.goto("/");
    await expect(page.getByText("Resolution vs Video Codec")).toBeVisible();
    await expect(page.getByText("Couldn't load this chart")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit chart settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Audio Codec", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Resolution vs Audio Codec")).toBeVisible();
    await expect(page.getByText("Couldn't load this chart")).toBeVisible();
  });
});
