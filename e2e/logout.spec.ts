import { test, expect } from "@playwright/test";
import { ADMIN } from "./constants";

/**
 * Logout returns to the login page. Logging out revokes EVERY session for the
 * admin (it bumps `sessionVersion`), including the saved `admin.json` state
 * the other specs reuse — which is why this spec lives in its own Playwright
 * project (`chromium-logout`) that depends on all the others and so runs
 * last. Local auth was enabled by the first-run setup, so logging back in with
 * the admin's password must work.
 */
test("logout revokes the session and local login works again", async ({ page, playwright, baseURL }) => {
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  // The cookie as it was before logging out: what a copy of it would carry.
  const before = await page.context().storageState();

  // The chip names the admin once the shell has hydrated and fetched
  // /api/auth/me — before that a click on the server-rendered button is lost.
  await expect(page.getByRole("link", { name: /e2eadmin/i })).toBeVisible();
  // The logout control is the user chip's "Logout" button in the sidebar.
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

  // Revoked, not just forgotten: the old cookie no longer signs anyone in.
  const stale = await playwright.request.newContext({ baseURL, storageState: before });
  expect((await stale.get("/api/auth/me")).status()).toBe(401);
  await stale.dispose();

  await expect(page.locator("#username")).toBeVisible();
  await page.locator("#username").fill(ADMIN.username);
  await page.locator("#password").fill(ADMIN.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/login/);
});
