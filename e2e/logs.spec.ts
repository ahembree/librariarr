import { test, expect } from "@playwright/test";

/**
 * System Logs: the console and its filter controls must render. The real app
 * writes log entries to the DB (setup, API requests), so we assert the controls
 * and a working filter interaction rather than an empty console.
 */
test.describe("system logs", () => {
  test("renders the console heading and filter controls", async ({ page }) => {
    await page.goto("/system/logs");
    await expect(page.getByRole("heading", { name: /^Logs$/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /log levels/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search messages...")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refresh$/i })).toBeVisible();
  });

  test("the level filter dropdown lists the log levels", async ({ page }) => {
    await page.goto("/system/logs");
    await page.getByRole("button", { name: /log levels/i }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /ERROR/i })).toBeVisible();
    await expect(page.getByRole("menuitemcheckbox", { name: /INFO/i })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("searching messages keeps the console on screen", async ({ page }) => {
    await page.goto("/system/logs");
    await page.getByPlaceholder("Search messages...").fill("sync");
    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect(page.getByRole("heading", { name: /^Logs$/i }).first()).toBeVisible();
  });
});
