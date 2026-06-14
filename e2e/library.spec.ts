import { test, expect } from "@playwright/test";

/**
 * Library section on an empty database: every view renders its heading, its
 * empty state, and its toolbar; the per-section sub-tabs navigate; and the
 * History and Query workspaces expose their controls.
 */
test.describe("library — movies", () => {
  test("renders heading, empty state, and view toggle", async ({ page }) => {
    await page.goto("/library/movies");
    await expect(page.getByRole("heading", { name: /^Movies$/i }).first()).toBeVisible();
    await expect(page.getByText("No movies found.")).toBeVisible();

    // The toolbar (card/table toggle) renders regardless of data. The toggle's
    // data-backed effect (table actually renders rows) is covered by
    // seeded-library.spec; here we only assert both controls are interactive.
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Table view" })).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.getByRole("button", { name: "Card view" })).toBeVisible();
  });
});

test.describe("library — series", () => {
  test("renders heading and empty state", async ({ page }) => {
    await page.goto("/library/series");
    await expect(page.getByRole("heading", { name: /^Series$/i }).first()).toBeVisible();
    await expect(page.getByText("No series found.")).toBeVisible();
  });

  test("sub-tabs navigate to seasons and episodes", async ({ page }) => {
    await page.goto("/library/series");

    await page.getByRole("link", { name: "All Seasons" }).click();
    await page.waitForURL(/\/library\/series\/seasons/);
    await expect(page.getByText("No seasons found.")).toBeVisible();

    await page.getByRole("link", { name: "All Episodes" }).click();
    await page.waitForURL(/\/library\/series\/episodes/);
    await expect(page.getByText("No episodes found.")).toBeVisible();
  });
});

test.describe("library — music", () => {
  test("renders heading and empty state", async ({ page }) => {
    await page.goto("/library/music");
    await expect(page.getByRole("heading", { name: /^Music$/i }).first()).toBeVisible();
    await expect(page.getByText("No artists found.")).toBeVisible();
  });

  test("sub-tabs navigate to albums and tracks", async ({ page }) => {
    await page.goto("/library/music");

    await page.getByRole("link", { name: "All Albums" }).click();
    await page.waitForURL(/\/library\/music\/albums/);
    await expect(page.getByText("No albums found.")).toBeVisible();

    await page.getByRole("link", { name: "All Tracks" }).click();
    await page.waitForURL(/\/library\/music\/tracks/);
    await expect(page.getByText("No tracks found.")).toBeVisible();
  });
});

test.describe("library — history", () => {
  test("renders heading, controls, and empty state", async ({ page }) => {
    await page.goto("/library/history");
    await expect(page.getByRole("heading", { name: /Watch History/i }).first()).toBeVisible();
    await expect(page.getByPlaceholder("Search titles...")).toBeVisible();
    await expect(page.getByText(/no watch history/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i })).toBeVisible();
  });
});

test.describe("library — query workspace", () => {
  test("renders the builder with the media-type scope toggles", async ({ page }) => {
    await page.goto("/library/query");
    await expect(page.getByRole("heading", { name: /Query Builder/i }).first()).toBeVisible();
    await expect(page.getByText(/media types/i).first()).toBeVisible();

    // The scope toggles are buttons (sidebar entries with the same names are links).
    for (const type of ["Movies", "Series", "Music"]) {
      await expect(page.getByRole("button", { name: type, exact: true })).toBeVisible();
    }
  });
});
