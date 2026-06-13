import { test, expect } from "@playwright/test";
import { ADMIN } from "./constants";

/**
 * Logout returns to the login page. Each test gets a fresh context from the
 * saved storage state, so logging out here does not affect other specs.
 * If local auth is enabled, we also verify logging back in.
 */
test("logout returns to the login page and local login works", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);

  // The logout control lives in the shell (sidebar/topbar). It may be a button
  // or a link; match by accessible name.
  const logout = page
    .getByRole("button", { name: /log ?out|sign ?out/i })
    .or(page.getByRole("link", { name: /log ?out|sign ?out/i }))
    .first();
  await logout.click();

  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

  // Local login round-trip (only if the username field is present).
  const username = page.locator("#username");
  if (await username.isVisible().catch(() => false)) {
    await username.fill(ADMIN.username);
    await page.locator("#password").fill(ADMIN.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/login/);
  }
});
