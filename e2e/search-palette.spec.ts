import { test, expect } from "@playwright/test";

/**
 * The global command palette (⌘K / Ctrl+K, or the sidebar search pill) searches
 * the library by title and offers a jump to the Query workspace. On an empty DB
 * every query resolves to "no matches", which still exercises the full flow.
 */
test.describe("search palette", () => {
  test("opens with the keyboard shortcut and shows the idle prompt", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/search your library/i)).toBeVisible();
    await expect(
      dialog.getByPlaceholder(/search movies, series, artists, albums/i),
    ).toBeVisible();
  });

  test("typing a query with no matches shows the empty result state", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");

    const input = page.getByPlaceholder(/search movies, series, artists, albums/i);
    await input.fill("zzzznomatch");
    await expect(page.getByText(/no matches for/i)).toBeVisible();
  });

  test("the Query workspace shortcut navigates to /library/query", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await page.getByText(/open the query workspace/i).click();
    await page.waitForURL(/\/library\/query/);
    await expect(page).toHaveURL(/\/library\/query/);
  });

  test("Escape closes the palette", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
