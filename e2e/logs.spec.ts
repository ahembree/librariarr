import { test, expect, type Page } from "@playwright/test";

/**
 * System Logs: the console and its filter controls must render. The real app
 * writes log entries to the DB (setup, API requests), so we assert the controls
 * and a working filter interaction rather than an empty console.
 */
/** The console has loaded, so the page is live and its controls respond. */
async function waitForConsole(page: Page) {
  await expect(
    page.getByText(/^\d[\d,]* entr(y|ies)/).or(page.getByText("No log entries found")),
  ).toBeVisible();
}

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
    await waitForConsole(page);
    await page.getByRole("button", { name: /log levels/i }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /ERROR/i })).toBeVisible();
    await expect(page.getByRole("menuitemcheckbox", { name: /INFO/i })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("searching messages queries the server and keeps the console on screen", async ({ page }) => {
    await page.goto("/system/logs");
    await waitForConsole(page);
    const searchButton = page.getByRole("button", { name: /^Search$/i });
    await page.getByPlaceholder("Search messages...").fill("sync");
    await expect(searchButton).toBeEnabled();

    const searched = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return url.pathname === "/api/system/logs" && url.searchParams.get("search") === "sync";
    });
    await searchButton.click();
    expect((await searched).status()).toBe(200);

    // The search is applied: nothing left to submit, a filter to clear.
    await expect(searchButton).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Clear all$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Logs$/i }).first()).toBeVisible();
  });
});
