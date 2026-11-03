import { test, expect, type Locator, type Page } from "@playwright/test";
import { storeDashboardLayout } from "./seed";
import { openDashboardInBrowser } from "./dashboard-nav";

/**
 * The Insights layout editor in a real browser: a card narrower or shorter
 * than its content keeps that content inside its own cell, and a dragged card
 * lands before or after the card under the pointer. Data routes are stubbed;
 * the saved layout comes with the server render, so it is stored for each test
 * and restored after it (a drag saves a new one through the app).
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

const breakdown = (field: string, values: string[]) =>
  values.map((value, i) => ({ [field]: value, type: "MOVIE", _count: 10 - i }));

const STATS = {
  movieCount: 10, seriesCount: 0, seasonCount: 0, musicCount: 0, artistCount: 0,
  albumCount: 0, episodeCount: 0, totalSize: "0", movieSize: "0", seriesSize: "0",
  musicSize: "0", movieDuration: 0, seriesDuration: 0, musicDuration: 0,
  qualityBreakdown: breakdown("resolution", ["4k", "1080", "720", "sd"]),
  topMovies: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, title: `Movie ${i}`, year: 2000 + i, playCount: 20 - i })),
  topSeries: [], topMusic: [],
  videoCodecBreakdown: breakdown("videoCodec", ["hevc", "h264", "av1"]),
  audioCodecBreakdown: breakdown("audioCodec", ["aac", "eac3", "truehd", "dts"]),
  contentRatingBreakdown: breakdown("contentRating", ["G", "PG", "PG-13", "R", "NR"]),
  dynamicRangeBreakdown: [], audioChannelsBreakdown: [], genreBreakdown: [],
};

// Two narrow cards whose header controls are wider than they are, and a
// short Top Played whose three lists are taller than it.
const LAYOUT = [
  { id: "quality-breakdown", size: 6 },
  { id: "video-codec", size: 6 },
  { id: "audio-codec", size: 3 },
  { id: "content-rating", size: 3 },
  { id: "top-played", size: 4, heightPx: 250 },
];

let restoreLayout: (() => Promise<void>) | undefined;

test.afterEach(async () => {
  await restoreLayout?.();
  restoreLayout = undefined;
});

async function openDashboard(page: Page) {
  restoreLayout = await storeDashboardLayout({ main: LAYOUT, movies: [], series: [], music: [] });
  await page.route(isPath("/api/media/stats"), (route) => route.fulfill({ json: STATS }));
  await page.route(isPath("/api/media/library-types"), (route) =>
    route.fulfill({ json: { types: ["MOVIE"], allTypes: ["MOVIE"] } }),
  );
  await openDashboardInBrowser(page);
  await expect(page.getByText("Content Rating Breakdown")).toBeVisible();
}

/** The Insights grid; its cells are the children holding a card title. */
function grid(page: Page): Locator {
  return page.locator("div.grid.md\\:grid-cols-12");
}

function cells(page: Page): Locator {
  return grid(page).locator(":scope > div:has([data-slot=card-title])");
}

function cardOrder(page: Page): Promise<string[]> {
  return cells(page).evaluateAll((els) =>
    els.map((el) => el.querySelector("[data-slot=card-title]")?.textContent?.trim() ?? ""),
  );
}

/**
 * How far, in px, anything a card draws reaches past the right and bottom
 * edges of the boxes holding the cards — after the clipping of every scrolling
 * or clipping box inside them.
 */
async function overflowOf(boxes: Locator) {
  const report = await boxes.evaluateAll((els) =>
    els.map((cell) => {
      const bounds = cell.getBoundingClientRect();
      let right = 0;
      let bottom = 0;
      for (const el of cell.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let a = el.parentElement; a && a !== cell; a = a.parentElement) {
          const style = getComputedStyle(a);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const clip = a.getBoundingClientRect();
          box = {
            left: Math.max(box.left, clip.left),
            top: Math.max(box.top, clip.top),
            right: Math.min(box.right, clip.right),
            bottom: Math.min(box.bottom, clip.bottom),
          };
        }
        if (box.right <= box.left || box.bottom <= box.top) continue;
        right = Math.max(right, box.right - bounds.right);
        bottom = Math.max(bottom, box.bottom - bounds.bottom);
      }
      const title = cell.querySelector("[data-slot=card-title]")?.textContent?.trim();
      return { title, right: Math.round(right), bottom: Math.round(bottom) };
    }),
  );
  expect(report).toHaveLength(LAYOUT.length);
  return report;
}

/** Drag a card by its handle to a point inside another card, given as fractions of its box. */
async function dragCard(page: Page, from: Locator, to: Locator, at: { x: number; y: number }) {
  const handle = await from.getByRole("button", { name: "Drag to move card" }).boundingBox();
  const target = await to.boundingBox();
  if (!handle || !target) throw new Error("card not on screen");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * at.x, target.y + target.height * at.y, { steps: 20 });
  await page.mouse.up();
}

test.describe("dashboard layout editor", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("cards narrower or shorter than their content keep it inside their cell", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByText("Movie 9")).toBeAttached();

    for (const cell of await overflowOf(cells(page))) {
      expect(cell, `${cell.title} paints past its cell`).toMatchObject({ right: 0, bottom: 0 });
    }

    // The same in edit mode, measured against each frame's content box: the
    // frame's resize handles sit in the gap beside it on purpose.
    await page.getByRole("button", { name: /^Customize$/ }).click();
    await expect(page.getByRole("button", { name: "Drag to move card" })).toHaveCount(LAYOUT.length);
    for (const cell of await overflowOf(grid(page).locator(".dashboard-cell"))) {
      expect(cell, `${cell.title} paints past its cell in edit mode`).toMatchObject({ right: 0, bottom: 0 });
    }
  });

  test("a dragged card lands before or after the card under the pointer, and is saved there", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    await expect(page.getByRole("button", { name: "Drag to move card" })).toHaveCount(LAYOUT.length);
    await cells(page).first().scrollIntoViewIfNeeded();

    // Content Rating onto the right half of Quality: after it.
    let saved = page.waitForResponse((r) => isPath("/api/settings/dashboard-layout")(new URL(r.url())) && r.request().method() === "PUT");
    await dragCard(page, cells(page).nth(3), cells(page).nth(0), { x: 0.8, y: 0.5 });
    expect((await saved).ok()).toBe(true);
    await expect.poll(() => cardOrder(page)).toEqual([
      "Quality Breakdown",
      "Content Rating Breakdown",
      "Video Codec Breakdown",
      "Audio Codec Breakdown",
      "Most Played Movies",
    ]);

    // Quality onto the left half of Audio Codec: before it.
    saved = page.waitForResponse((r) => isPath("/api/settings/dashboard-layout")(new URL(r.url())) && r.request().method() === "PUT");
    await dragCard(page, cells(page).nth(0), cells(page).nth(3), { x: 0.2, y: 0.3 });
    expect((await saved).ok()).toBe(true);
    await expect.poll(() => cardOrder(page)).toEqual([
      "Content Rating Breakdown",
      "Video Codec Breakdown",
      "Quality Breakdown",
      "Audio Codec Breakdown",
      "Most Played Movies",
    ]);

    const stored = await page.request.get("/api/settings/dashboard-layout");
    const { layout } = (await stored.json()) as { layout: { main: { id: string }[] } };
    expect(layout.main.map((c) => c.id)).toEqual(["content-rating", "video-codec", "quality-breakdown", "audio-codec", "top-played"]);
  });

  test("Auto height gives a card with a set height its natural height back", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    const topPlayed = cells(page).filter({ hasText: "Most Played Movies" });
    await expect(topPlayed).toHaveCSS("height", "250px");

    await topPlayed.getByRole("button", { name: "Auto height" }).click();
    await expect(topPlayed.getByRole("button", { name: "Auto height" })).toHaveCount(0);
    await expect.poll(async () => (await topPlayed.boundingBox())?.height ?? 0).toBeGreaterThan(250);
  });
});
