import { test, expect } from "@playwright/test";

/**
 * The dashboard is the landing page. It renders a time-based greeting, the
 * lifecycle-pipeline zone (with its empty state on a fresh install), and the
 * customizable Insights grid whose edit mode toggles in place.
 */
test.describe("dashboard", () => {
  test("renders the greeting and lifecycle pipeline zone", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /good (morning|afternoon|evening)/i }).first(),
    ).toBeVisible();
    await expect(page.getByText(/lifecycle pipeline/i).first()).toBeVisible();
  });

  test("lifecycle pipeline shows the empty state with a create link", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/no lifecycle rules yet/i)).toBeVisible();
    const create = page.getByRole("link", { name: /create a rule set/i });
    await expect(create).toBeVisible();
    await create.click();
    await page.waitForURL(/\/lifecycle\/rules/);
    await expect(page).toHaveURL(/\/lifecycle\/rules/);
  });

  test("insights customize mode toggles in place", async ({ page }) => {
    await page.goto("/");
    const customize = page.getByRole("button", { name: /^Customize$/i });
    await expect(customize).toBeVisible();
    await customize.click();
    const done = page.getByRole("button", { name: /^Done$/i });
    await expect(done).toBeVisible();
    await done.click();
    await expect(page.getByRole("button", { name: /^Customize$/i })).toBeVisible();
  });
});
