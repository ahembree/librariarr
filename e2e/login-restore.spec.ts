import { test, expect } from "@playwright/test";

/**
 * First-run "Restore from Backup" on the login page, with the setup routes
 * stubbed (the admin already exists in the e2e database, so the real routes
 * would refuse). A refusal — the rate limit, setup already done, a bad body —
 * is plain JSON sent before any stream opens; read as the NDJSON stream it is
 * not, the server's reason became a bare "Restore failed".
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

test.use({ storageState: { cookies: [], origins: [] } });

test("a refused setup restore shows the server's reason", async ({ page }) => {
  // What the route answers before any account exists: no sign-in method yet.
  await page.route(isPath("/api/auth/check-setup"), (route) =>
    route.fulfill({
      json: { setupRequired: true, localAuthEnabled: false, plexLoginEnabled: false, ssoEnabled: false, ssoMode: "OIDC" },
    }),
  );
  await page.route(isPath("/api/backup/list-setup"), (route) =>
    route.fulfill({
      json: {
        backups: [
          {
            filename: "librariarr-backup-2026-01-01T00-00-00.json.gz",
            createdAt: "2026-01-01T00:00:00.000Z",
            size: 2048,
            tables: { user: 1, appSettings: 1, mediaServer: 1, library: 3, ruleSet: 2 },
            encrypted: false,
            configOnly: true,
          },
        ],
      },
    }),
  );
  let restoreBody: unknown = null;
  // The setup bucket's refusal, word for word (`tooManyAttempts`).
  await page.route(isPath("/api/backup/restore-setup"), (route) => {
    restoreBody = route.request().postDataJSON();
    return route.fulfill({
      status: 429,
      headers: { "Retry-After": "900" },
      json: { error: "Too many attempts. Try again later." },
    });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: /Restore from Backup/ }).click();
  await page.getByRole("button", { name: /Restore Selected Backup/ }).click();

  await expect(page.getByText("Too many attempts. Try again later.")).toBeVisible();
  await expect(page.getByText("Restore failed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Restore Selected Backup/ })).toBeEnabled();
  expect(restoreBody).toEqual({ filename: "librariarr-backup-2026-01-01T00-00-00.json.gz" });
});
