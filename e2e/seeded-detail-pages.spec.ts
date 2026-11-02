import { test, expect } from "@playwright/test";
import { seedGroupedLibraries, cleanupGroupedSeed, dropAppCaches, GROUPED_SEED as S } from "./seed";

/**
 * The detail pages that group rows — a show, a season and an episode; an
 * artist, an album and a track — each loaded with a seeded episode/track id,
 * as every listing links to them. The seeded server listens nowhere, so the
 * live lookups (series summary, play history refresh) fail and the pages must
 * still render the stored data.
 */
test.describe("seeded series detail pages", () => {
  test.beforeAll(async () => {
    await seedGroupedLibraries();
  });

  // The rows went in past the app, so a listing an earlier spec cached over the
  // empty database (the server keeps one for a minute) must go first.
  test.beforeEach(async ({ page }) => {
    await dropAppCaches(page.request);
  });

  test.afterAll(async () => {
    await cleanupGroupedSeed();
  });

  test("the show page names the show and lists its season", async ({ page }) => {
    await page.goto(`/library/series/show/${S.episodes[0].id}`);
    await expect(page.getByText(S.showTitle).first()).toBeVisible();
    await expect(page.getByText(/2 episodes/).first()).toBeVisible();
    await expect(page.getByText("Season 1").first()).toBeVisible();
    await expect(page.getByText("Series not found")).toHaveCount(0);
  });

  test("the season page lists both episodes and opens one", async ({ page }) => {
    await page.goto(`/library/series/season/${S.episodes[0].id}`);
    await expect(page.getByText("Season 1").first()).toBeVisible();
    await expect(page.getByText(S.episodes[0].title).first()).toBeVisible();
    await expect(page.getByText(S.episodes[1].title).first()).toBeVisible();

    await page.getByText(S.episodes[1].title).first().click();
    await page.waitForURL(new RegExp(`/library/series/episode/${S.episodes[1].id}`));
    await expect(page.getByText(S.showTitle).first()).toBeVisible();
  });

  test("the episode page names the show and the episode", async ({ page }) => {
    await page.goto(`/library/series/episode/${S.episodes[0].id}`);
    await expect(page.getByText(S.showTitle).first()).toBeVisible();
    await expect(page.getByText(S.episodes[0].title).first()).toBeVisible();
    await expect(page.getByText("Episode not found")).toHaveCount(0);
  });

  test("an unknown id shows the not-found state", async ({ page }) => {
    await page.goto("/library/series/episode/e2e-no-such-episode");
    await expect(page.getByText("Episode not found")).toBeVisible();
  });

  test("the Series listing links the seeded show", async ({ page }) => {
    await page.goto("/library/series");
    await expect(page.getByText(S.showTitle).first()).toBeVisible();
  });
});

test.describe("seeded music detail pages", () => {
  test.beforeAll(async () => {
    await seedGroupedLibraries();
  });

  // The rows went in past the app, so a listing an earlier spec cached over the
  // empty database (the server keeps one for a minute) must go first.
  test.beforeEach(async ({ page }) => {
    await dropAppCaches(page.request);
  });

  test.afterAll(async () => {
    await cleanupGroupedSeed();
  });

  test("the artist page names the artist and lists the album", async ({ page }) => {
    await page.goto(`/library/music/artist/${S.tracks[0].id}`);
    await expect(page.getByText(S.artistTitle).first()).toBeVisible();
    await expect(page.getByText(S.albumTitle).first()).toBeVisible();
    await expect(page.getByText("Artist not found")).toHaveCount(0);
  });

  test("the album page lists both tracks and opens one", async ({ page }) => {
    await page.goto(`/library/music/album/${S.tracks[0].id}`);
    await expect(page.getByText(S.albumTitle).first()).toBeVisible();
    await expect(page.getByText(S.tracks[0].title).first()).toBeVisible();
    await expect(page.getByText(S.tracks[1].title).first()).toBeVisible();

    await page.getByText(S.tracks[1].title).first().click();
    await page.waitForURL(new RegExp(`/library/music/track/${S.tracks[1].id}`));
    await expect(page.getByText(S.tracks[1].title).first()).toBeVisible();
  });

  test("the track page names the artist and the track", async ({ page }) => {
    await page.goto(`/library/music/track/${S.tracks[0].id}`);
    await expect(page.getByText(S.artistTitle).first()).toBeVisible();
    await expect(page.getByText(S.tracks[0].title).first()).toBeVisible();
    await expect(page.getByText("Track not found")).toHaveCount(0);
  });

  test("an unknown track id shows the not-found state", async ({ page }) => {
    await page.goto("/library/music/track/e2e-no-such-track");
    await expect(page.getByText("Track not found")).toBeVisible();
  });

  test("the Music listing shows the seeded artist", async ({ page }) => {
    await page.goto("/library/music");
    await expect(page.getByText(S.artistTitle).first()).toBeVisible();
  });
});
