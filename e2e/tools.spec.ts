import { test, expect } from "@playwright/test";

/**
 * Tools section on an empty database. Stream Manager renders its four sections
 * and the blackout-schedule dialog; Preroll Manager renders its sections, the
 * Plex-required notice, and the preset/schedule dialogs.
 */
test.describe("tools — stream manager", () => {
  test("renders all sections and their empty states", async ({ page }) => {
    await page.goto("/tools/streams");
    await expect(page.getByRole("heading", { name: /Stream Manager/i }).first()).toBeVisible();

    for (const section of [
      "Active Sessions",
      "Maintenance Mode",
      "Transcode Manager",
      "Blackout Schedules",
    ]) {
      await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByText(/no active streams/i)).toBeVisible();
    await expect(page.getByText(/no blackout schedules/i)).toBeVisible();
  });

  test("opens the new blackout schedule dialog", async ({ page }) => {
    await page.goto("/tools/streams");
    await page.getByRole("button", { name: /new schedule/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/new blackout schedule/i)).toBeVisible();
    await expect(dialog.getByPlaceholder(/weekend maintenance/i)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("tools — preroll manager", () => {
  test("renders sections, the Plex notice, and empty states", async ({ page }) => {
    await page.goto("/tools/preroll");
    await expect(page.getByRole("heading", { name: /Preroll Manager/i }).first()).toBeVisible();

    // With no Plex server connected, the requirement notice is shown.
    await expect(page.getByText(/requires a Plex media server/i)).toBeVisible();

    await expect(page.getByText(/saved presets/i).first()).toBeVisible();
    await expect(page.getByText(/no presets saved yet/i)).toBeVisible();
    await expect(page.getByText(/no schedules configured/i)).toBeVisible();
  });

  test("opens the save-preset dialog", async ({ page }) => {
    await page.goto("/tools/preroll");
    await page.getByRole("button", { name: /save as preset/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#preset-name")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("opens the new schedule dialog", async ({ page }) => {
    await page.goto("/tools/preroll");
    await page.getByRole("button", { name: /new schedule/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#schedule-name")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
