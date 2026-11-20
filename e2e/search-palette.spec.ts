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

/** Results enough to overflow the palette on a phone: every group full. */
function manyResults() {
  const item = (scope: string, type: string, n: number, title: string, extra: Record<string, unknown> = {}) => ({
    id: `e2e-palette-${scope}-${n}`,
    title,
    type,
    scope,
    ...extra,
  });
  return {
    results: {
      MOVIE: Array.from({ length: 6 }, (_, i) => item("individual", "MOVIE", i, `Palette Movie ${i + 1}`, { year: 2000 + i })),
      SERIES: Array.from({ length: 6 }, (_, i) => item("series", "SERIES", i, `Palette Show ${i + 1}`, { itemCount: 3 })),
      MUSIC: [
        ...Array.from({ length: 4 }, (_, i) => item("artist", "MUSIC", i, `Palette Band ${i + 1}`, { itemCount: 3 })),
        ...Array.from({ length: 4 }, (_, i) =>
          item("album", "MUSIC", i, `Palette Album ${i + 1}`, { parentTitle: "Palette Band", itemCount: 3 }),
        ),
      ],
    },
  };
}

test.describe("search palette on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("fills the screen, and a drag scrolls the results, not the page", async ({ page }) => {
    await page.route((url) => url.pathname === "/api/media/search", (route) => route.fulfill({ json: manyResults() }));
    await page.goto("/");
    // A phone opens it from the drawer's search pill.
    await page.getByRole("button", { name: "Open navigation menu" }).tap();
    await page.getByRole("button", { name: /search library/i }).last().tap();
    const dialog = page.getByRole("dialog", { name: "Search library" });
    await expect(dialog).toBeVisible();

    const input = dialog.getByPlaceholder(/search movies, series, artists, albums/i);
    await input.fill("palette");
    await expect(dialog.getByText("Palette Album 4")).toBeAttached();

    // The whole visible screen, so nothing hides under the keyboard.
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.height).toBeCloseTo(844, 0);

    const list = page.locator("[data-slot=command-list]");
    const scrollTops = () =>
      page.evaluate(() => ({
        list: document.querySelector("[data-slot=command-list]")!.scrollTop,
        page: document.querySelector("main")!.scrollTop,
      }));
    const before = await scrollTops();
    expect(before.list).toBe(0);

    // A finger dragging up through the results.
    const listBox = (await list.boundingBox())!;
    const x = Math.round(listBox.x + listBox.width / 2);
    const y = Math.round(listBox.y + listBox.height * 0.75);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    // Paced like a finger (a frame apart): back-to-back events left the
    // browser's gesture state unsettled, and the next tap made no click.
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 25 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);

    await expect.poll(async () => (await scrollTops()).list).toBeGreaterThan(100);
    expect((await scrollTops()).page).toBe(before.page);
    // The drag put the keyboard away; the query stays.
    await expect(input).not.toBeFocused();
    await expect(input).toHaveValue("palette");

    // No Esc on a phone, and nothing outside the palette to tap.
    await dialog.getByRole("button", { name: "Cancel" }).tap();
    await expect(dialog).toHaveCount(0);
  });
});

