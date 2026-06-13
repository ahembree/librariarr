import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ADMIN, AUTH_STATE } from "./constants";

/**
 * Drives the real first-run flow: on a fresh database the login page offers a
 * "Create Local Account" form. Creating the admin logs the session in; we save
 * that authenticated storage state for every other authenticated project to
 * reuse. This doubles as the E2E test for the setup journey itself.
 */
test("first-run: create the local admin and persist the session", async ({ page }) => {
  await page.goto("/login");

  // The setup form may be revealed by a "Create Local Account" button.
  const reveal = page.getByRole("button", { name: /create local account/i });
  if (await reveal.isVisible().catch(() => false)) {
    await reveal.click();
  }

  await page.locator("#setup-username").fill(ADMIN.username);
  await page.locator("#setup-password").fill(ADMIN.password);
  await page.locator("#setup-confirm-password").fill(ADMIN.password);

  await page.getByRole("button", { name: /^create account$/i }).click();

  // A successful setup logs in and navigates away from /login.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  expect(page.url()).not.toContain("/login");

  mkdirSync(dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
});
