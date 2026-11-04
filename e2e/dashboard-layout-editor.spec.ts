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

async function openDashboard(page: Page, layout: object[] = LAYOUT) {
  restoreLayout = await storeDashboardLayout({ main: layout, movies: [], series: [], music: [] });
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

type StoredCard = { id: string; size: number; heightPx?: number; display?: unknown };

async function storedCards(page: Page): Promise<StoredCard[]> {
  const res = await page.request.get("/api/settings/dashboard-layout");
  return ((await res.json()) as { layout: { main: StoredCard[] } }).layout.main;
}

const storedIds = async (page: Page) => (await storedCards(page)).map((c) => c.id);
const storedCard = async (page: Page, id: string) => (await storedCards(page)).find((c) => c.id === id);

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
    // The whole grid on screen below the sticky header, so neither drag ends
    // near an edge and sets off the drag's auto-scroll.
    await cells(page).first().evaluate((el) => {
      (el as HTMLElement).style.scrollMarginTop = "150px";
      el.scrollIntoView({ block: "start" });
    });

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

  test("a narrow card's edit controls stay apart and inside it", async ({ page }) => {
    // Two columns of twelve: placed separately, Auto height ran under Remove.
    await openDashboard(page, [{ id: "content-rating", size: 2, heightPx: 300 }, { id: "audio-codec", size: 10 }]);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    const narrow = cells(page).filter({ hasText: "Content Rating" });
    const boxes = await Promise.all(
      ["Drag to move card", "Auto height", "Remove card"].map(async (name) => {
        const box = await narrow.getByRole("button", { name }).boundingBox();
        if (!box) throw new Error(`${name} is not on screen`);
        return box;
      }),
    );
    const card = await narrow.boundingBox();
    if (!card) throw new Error("card not on screen");
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x, "each control starts after the one before ends").toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
    }
    expect(boxes[0].x).toBeGreaterThanOrEqual(card.x);
    expect(boxes[2].x + boxes[2].width).toBeLessThanOrEqual(card.x + card.width);

    // The card's own dropdowns narrow and wrap to fit inside it too.
    for (const select of await narrow.getByRole("combobox").all()) {
      const box = await select.boundingBox();
      if (!box) throw new Error("dropdown not on screen");
      expect(box.x).toBeGreaterThanOrEqual(card.x);
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
    }
  });

  test("a card keeps its own choices through the editor, and they are saved with the layout", async ({ page }) => {
    await openDashboard(page);
    const card = cells(page).filter({ hasText: "Video Codec Breakdown" });
    await card.getByRole("combobox").filter({ hasText: "Top 5" }).click();
    await page.getByRole("option", { name: "Top 10" }).click();
    await card.getByRole("button", { name: "Donut view" }).click();
    await card.getByRole("button", { name: /^HEVC/ }).click();
    await expect.poll(async () => (await storedCard(page, "video-codec"))?.display).toEqual({
      topN: 10,
      view: "donut",
      hidden: ["HEVC"],
    });

    // Opening and closing the editor no longer re-creates the card.
    const chosen = async () => ({
      topN: await card.getByRole("combobox").filter({ hasText: /^Top|^All$/ }).textContent(),
      donut: await card.getByRole("button", { name: "Donut view" }).getAttribute("aria-pressed"),
    });
    const before = await chosen();
    await page.getByRole("button", { name: /^Customize$/ }).click();
    await expect(page.getByRole("button", { name: "Drag to move card" })).toHaveCount(LAYOUT.length);
    expect(await chosen()).toEqual(before);
    await page.getByRole("button", { name: "Done" }).click();
    expect(await chosen()).toEqual({ topN: "Top 10", donut: "true" });
  });

  test("a removed card comes back where it was with Undo", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    await cells(page).filter({ hasText: "Video Codec Breakdown" }).getByRole("button", { name: "Remove card" }).click();
    await expect(cells(page)).toHaveCount(LAYOUT.length - 1);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(cells(page)).toHaveCount(LAYOUT.length);
    await expect.poll(() => storedIds(page)).toEqual(LAYOUT.map((c) => c.id));
  });

  test("Reset puts the default cards back, and Undo restores the layout it replaced", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    await page.getByRole("button", { name: "Reset" }).click();
    await expect.poll(() => storedIds(page)).toEqual(["quality-breakdown", "top-played"]);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => storedIds(page)).toEqual(LAYOUT.map((c) => c.id));
  });

  test("the size handles work from the keyboard", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^Customize$/ }).click();
    const quality = cells(page).filter({ hasText: "Quality Breakdown" });

    await quality.getByRole("separator", { name: "Card width" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await storedCard(page, "quality-breakdown"))?.size).toBe(5);
    await expect(quality.getByRole("separator", { name: "Card width" })).toHaveAttribute("aria-valuenow", "5");

    await quality.getByRole("separator", { name: "Card height" }).focus();
    await page.keyboard.press("End");
    await expect.poll(async () => (await storedCard(page, "quality-breakdown"))?.heightPx).toBe(800);
    await expect(quality).toHaveCSS("height", "800px");
  });

  test("a set height does not apply on a phone", async ({ page }) => {
    await openDashboard(page);
    const topPlayed = cells(page).filter({ hasText: "Most Played Movies" });
    await expect(topPlayed).toHaveCSS("height", "250px");
    // Narrowed to a phone (opened there, the dashboard link is in the closed drawer).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => topPlayed.evaluate((el) => (el as HTMLElement).style.height)).toBe("");
    expect((await topPlayed.boundingBox())?.height ?? 0).toBeGreaterThan(250);
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
