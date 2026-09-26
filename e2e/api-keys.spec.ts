import { test, expect } from "@playwright/test";

/**
 * API keys, end to end: issued from Settings → Authentication, shown exactly
 * once, usable against the public /api/v1 API within their scopes, and dead
 * the moment they are deleted.
 */
test.describe("API keys", () => {
  test("create a read-only key, use it, and revoke it", async ({ page, playwright, baseURL }) => {
    // A cookie-less client, like any third-party app: the API takes keys only.
    const api = await playwright.request.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });

    await page.goto("/settings#authentication");
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();
    await expect(page.getByText(/no api keys yet/i)).toBeVisible();

    // ── Create ──
    await page.getByRole("button", { name: /create api key/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("E2E dashboard");
    await expect(dialog.getByRole("radio", { name: /read-only/i })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: /create key/i }).click();

    // ── Shown once ──
    const keyField = dialog.getByRole("textbox", { name: "API key", exact: true });
    await expect(keyField).toHaveValue(/^lbr_[0-9A-Za-z]{43}$/);
    const key = await keyField.inputValue();
    await expect(dialog.getByText(/will not be shown again/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole("listitem").filter({ hasText: "E2E dashboard" });
    await expect(row).toContainText(key.slice(0, 10));
    await expect(row.getByText("Read-only")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);

    // …and never again, not even after a reload.
    await page.reload();
    await expect(row).toBeVisible();
    await expect(page.locator("body")).not.toContainText(key);

    // ── Used ──
    const auth = { Authorization: `Bearer ${key}` };
    const me = await api.get("/api/v1/me", { headers: auth });
    expect(me.status()).toBe(200);
    expect((await me.json()).apiKey.name).toBe("E2E dashboard");
    expect((await api.get("/api/v1/servers", { headers: auth })).status()).toBe(200);
    // Read-only: every write is refused.
    expect((await api.post("/api/v1/jobs/sync", { headers: auth })).status()).toBe(403);
    // No key, no access — a browser session would not help either.
    expect((await api.get("/api/v1/me")).status()).toBe(401);

    // ── Revoked ──
    await row.getByRole("button", { name: /delete api key e2e dashboard/i }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /delete key/i }).click();
    await expect(row).toBeHidden();
    await expect(page.getByText(/no api keys yet/i)).toBeVisible();

    expect((await api.get("/api/v1/me", { headers: auth })).status()).toBe(401);
    await api.dispose();
  });

  test("a custom key gets exactly the scopes picked, plus the reads they need", async ({ page, playwright, baseURL }) => {
    const api = await playwright.request.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });

    await page.goto("/settings#authentication");
    await page.getByRole("button", { name: /create api key/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("E2E sync bot");
    await dialog.getByRole("radio", { name: /custom scopes/i }).click();
    await dialog.getByLabel(/run syncs/i).check();
    // The read it needs is ticked and locked.
    await expect(dialog.getByLabel(/read servers/i)).toBeChecked();
    await expect(dialog.getByLabel(/read servers/i)).toBeDisabled();
    await dialog.getByLabel("Expiration").click();
    await page.getByRole("option", { name: "7 days" }).click();
    await dialog.getByRole("button", { name: /create key/i }).click();

    const key = await dialog.getByRole("textbox", { name: "API key", exact: true }).inputValue();
    await dialog.getByRole("button", { name: "Done" }).click();

    const auth = { Authorization: `Bearer ${key}` };
    const me = await (await api.get("/api/v1/me", { headers: auth })).json();
    expect(me.apiKey.scopes).toEqual(["servers:read", "sync:write"]);
    expect(new Date(me.apiKey.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await api.get("/api/v1/media/movies", { headers: auth })).status()).toBe(403);

    // Clean up so other specs see an empty list.
    const row = page.getByRole("listitem").filter({ hasText: "E2E sync bot" });
    await row.getByRole("button", { name: /delete api key/i }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /delete key/i }).click();
    await expect(row).toBeHidden();
    await api.dispose();
  });
});
