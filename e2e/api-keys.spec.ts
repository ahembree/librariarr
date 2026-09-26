import { test, expect } from "@playwright/test";
import { ADMIN } from "./constants";

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

    // ── OpenAPI document: browsable in Swagger UI, downloadable, built for this address ──
    await page.getByRole("link", { name: /^api docs$/i }).click();
    await expect(page.getByRole("heading", { name: /^API Docs$/i })).toBeVisible();
    // Swagger UI rendered the generated document: its title, an operation, the Authorize button.
    await expect(page.locator(".swagger-ui .info .title")).toContainText("Librariarr API");
    await expect(page.locator(".swagger-ui .opblock-summary-path").filter({ hasText: "/me" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /authorize/i }).first()).toBeVisible();
    const specHref = await page.getByRole("link", { name: /raw json/i }).getAttribute("href");
    const spec = await page.request.get(specHref!);
    expect(spec.status()).toBe(200);
    const doc = await spec.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe(`${baseURL}/api/v1`);
    expect(doc.paths["/me"].get["x-scope"]).toBeNull();
    const downloadHref = await page.getByRole("link", { name: /^download$/i }).getAttribute("href");
    const file = await page.request.get(downloadHref!);
    expect(file.headers()["content-disposition"]).toContain("librariarr-openapi.json");
    await page.getByRole("link", { name: /^api keys$/i }).click();
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

    // ── Create ──
    await page.getByRole("button", { name: /create api key/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("E2E dashboard");
    await expect(dialog.getByRole("radio", { name: /read-only/i })).toHaveAttribute("aria-checked", "true");
    // Creating a key is a step up from being signed in: the admin has a
    // password, so the dialog asks for it, and a wrong one is refused.
    const createButton = dialog.getByRole("button", { name: /create key/i });
    await expect(createButton).toBeDisabled();
    await dialog.getByLabel("Current password").fill("not-the-password");
    await createButton.click();
    await expect(dialog.getByText(/that password is not correct/i)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/lbr_[0-9A-Za-z]{43}/);
    await dialog.getByLabel("Current password").fill(ADMIN.password);
    await createButton.click();

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
    await dialog.getByLabel("Current password").fill(ADMIN.password);
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
