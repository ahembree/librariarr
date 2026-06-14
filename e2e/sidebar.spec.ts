import { test, expect, type Page } from "@playwright/test";
import { NAV_LINKS } from "./constants";

/**
 * The desktop sidebar is the app's primary menu. Every link must route to the
 * right place, the group labels must render, collapse state must persist, and
 * the search pill must open the command palette.
 *
 * Link clicks start from /settings — a neutral page whose main content has no
 * competing library/lifecycle links — so the sidebar link is the only match.
 */
function pathname(page: Page): string {
  return new URL(page.url()).pathname;
}

test.describe("sidebar navigation", () => {
  test("renders all navigation group labels", async ({ page }) => {
    await page.goto("/settings");
    for (const label of ["Overview", "Library", "Lifecycle", "Tools", "System"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  for (const { name, path } of NAV_LINKS) {
    test(`nav link ${name} → ${path}`, async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("link", { name }).first().click();
      await page.waitForURL((url) => url.pathname === path);
      expect(pathname(page)).toBe(path);
    });
  }

  test("collapse toggle persists across reload", async ({ page }) => {
    await page.goto("/settings");

    const collapse = page.getByRole("button", { name: /collapse sidebar/i });
    await expect(collapse).toBeVisible();
    await collapse.click();

    // Collapsing swaps in the "Expand sidebar" affordance.
    const expand = page.getByRole("button", { name: /expand sidebar/i });
    await expect(expand).toBeVisible();

    // The collapse state lives in a cookie, so it survives a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: /expand sidebar/i })).toBeVisible();

    // Restore the expanded state so other specs start from a known layout.
    await page.getByRole("button", { name: /expand sidebar/i }).click();
    await expect(page.getByRole("button", { name: /collapse sidebar/i })).toBeVisible();
  });

  test("search pill opens the command palette", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: /search library/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByPlaceholder(/search movies, series, artists, albums/i)).toBeVisible();
  });

  test("user chip links to the authentication settings", async ({ page }) => {
    await page.goto("/system/logs");
    // The chip shows the admin username and links to settings#authentication.
    await page.getByRole("link", { name: /e2eadmin/i }).first().click();
    await page.waitForURL(/\/settings/);
    await expect(page).toHaveURL(/\/settings/);
  });
});
