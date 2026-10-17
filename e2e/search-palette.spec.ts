import { test, expect, type Page } from "@playwright/test";

/**
 * The global command palette (⌘K / Ctrl+K, or the sidebar search pill) searches
 * the library by title and offers a jump to the Query workspace. On an empty DB
 * every query resolves to "no matches", which still exercises the full flow.
 */

/**
 * Opens the palette with Ctrl+K. The shortcut's listener is attached once the
 * shell has hydrated, so a press straight after navigation can be lost; press
 * again until the palette is open (opening it twice is harmless).
 */
async function openPalette(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test.describe("search palette", () => {
  test("opens with the keyboard shortcut and shows the idle prompt", async ({ page }) => {
    await page.goto("/");
    await openPalette(page);

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/search your library/i)).toBeVisible();
    await expect(
      dialog.getByPlaceholder(/search movies, series, artists, albums/i),
    ).toBeVisible();
  });

  test("typing a query with no matches shows the empty result state", async ({ page }) => {
    await page.goto("/");
    await openPalette(page);

    const input = page.getByPlaceholder(/search movies, series, artists, albums/i);
    await input.fill("zzzznomatch");
    // The state names the query that found nothing.
    await expect(page.getByRole("dialog").getByText('No matches for "zzzznomatch"')).toBeVisible();
  });

  test("the Query workspace shortcut navigates to /library/query", async ({ page }) => {
    await page.goto("/");
    await openPalette(page);
    await page.getByText(/open the query workspace/i).click();
    await page.waitForURL(/\/library\/query/);
    await expect(page.getByRole("heading", { name: /Query Builder/i })).toBeVisible();
  });

  test("Escape closes the palette", async ({ page }) => {
    await page.goto("/");
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
