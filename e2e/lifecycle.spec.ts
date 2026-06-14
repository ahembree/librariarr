import { test, expect } from "@playwright/test";

/**
 * Lifecycle section on an empty database: the rules workspace, the matches and
 * pending queues, and the exceptions list all render their controls and empty
 * states, and the key interactions (tab switching, builder entry, add-exception
 * dialog, status filters) work.
 */
test.describe("lifecycle — rules", () => {
  test("renders the builder with media-type tabs", async ({ page }) => {
    await page.goto("/lifecycle/rules");
    await expect(page.getByRole("heading", { name: /Lifecycle Rules/i }).first()).toBeVisible();

    for (const t of ["Movies", "Series", "Music"]) {
      await expect(page.getByRole("tab", { name: t, exact: true })).toBeVisible();
    }

    // The builder form is always present (rule set name field + entry button).
    await expect(page.getByRole("button", { name: /new rule set/i }).first()).toBeVisible();
    await expect(page.getByPlaceholder(/rule set name/i)).toBeVisible();
  });

  test("switching to the Series tab activates it", async ({ page }) => {
    await page.goto("/lifecycle/rules");
    const series = page.getByRole("tab", { name: "Series", exact: true });
    await series.click();
    await expect(series).toHaveAttribute("aria-selected", "true");
    await expect(page.getByPlaceholder(/rule set name/i)).toBeVisible();
  });
});

test.describe("lifecycle — matches", () => {
  test("renders the empty state and re-evaluate control", async ({ page }) => {
    await page.goto("/lifecycle/matches");
    await expect(page.getByRole("heading", { name: /Rule Matches/i }).first()).toBeVisible();
    await expect(page.getByText(/no enabled rule sets/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /re-evaluate all/i })).toBeVisible();
  });
});

test.describe("lifecycle — pending", () => {
  test("renders status filters and the empty state", async ({ page }) => {
    await page.goto("/lifecycle/pending");
    await expect(page.getByRole("heading", { name: /Pending Actions/i }).first()).toBeVisible();

    for (const status of ["Pending", "Completed", "Failed", "All"]) {
      await expect(page.getByRole("button", { name: status, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/no pending actions/i)).toBeVisible();

    // Switching the status filter actually changes the view: the Completed
    // tab shows its own distinct empty state.
    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(page.getByText(/no completed actions yet/i)).toBeVisible();
  });
});

test.describe("lifecycle — exceptions", () => {
  test("renders the empty state and opens the add-exception dialog", async ({ page }) => {
    await page.goto("/lifecycle/exceptions");
    await expect(page.getByRole("heading", { name: /Lifecycle Exceptions/i }).first()).toBeVisible();
    await expect(page.getByText(/no exceptions/i)).toBeVisible();

    await page.getByRole("button", { name: /add exception/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("#exception-search")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
