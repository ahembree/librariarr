import { test, expect } from "@playwright/test";
import { SETTINGS_TABS } from "./constants";

/**
 * Settings is a single page with seven role="tab" sections. Each tab must be
 * reachable and render its panel; a saved appearance change must round-trip;
 * and the key empty-state controls for an unconfigured install must be present.
 */
test.describe("settings", () => {
  test("every tab is reachable and renders its panel heading", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /^Settings$/i }).first()).toBeVisible();

    for (const { tab, heading } of SETTINGS_TABS) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    }
  });

  test("accent color selection persists across reload", async ({ page }) => {
    await page.goto("/settings#general");

    const savedPut = () =>
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/settings/accent-color") && r.request().method() === "PUT",
      );

    // Accent swatches are title-labelled buttons; the selected one shows a check.
    const violet = page.getByRole("button", { name: "Violet" });
    await Promise.all([savedPut(), violet.click()]);
    await expect(violet.locator("svg")).toBeVisible();

    // The saved accent is re-fetched on load, so it survives a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "Violet" }).locator("svg")).toBeVisible();

    // Reset to the default accent so other specs see a clean baseline.
    await Promise.all([savedPut(), page.getByRole("button", { name: "Default" }).click()]);
    await expect(page.getByRole("button", { name: "Default" }).locator("svg")).toBeVisible();
  });

  test("media servers tab shows the empty state and add control", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Media Servers$/i }).click();
    await expect(page.getByText(/no media servers connected/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /add server/i }).first()).toBeVisible();
  });

  test("integrations tab lists the supported Arr services", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Integrations$/i }).click();
    await expect(page.getByRole("heading", { name: /^Integrations$/i }).first()).toBeVisible();
    for (const svc of ["Sonarr", "Radarr", "Lidarr"]) {
      await expect(page.getByText(svc, { exact: true }).first()).toBeVisible();
    }
  });

  test("notifications tab exposes the Discord webhook field", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Notifications$/i }).click();
    await expect(page.getByText(/discord webhook/i).first()).toBeVisible();
    await expect(page.locator("#discord-webhook-url")).toBeVisible();
  });

  test("authentication tab shows Plex and local auth sections", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Authentication$/i }).click();
    await expect(page.getByText(/plex connection/i).first()).toBeVisible();
    await expect(page.getByText(/local authentication/i).first()).toBeVisible();
  });

  test("system tab shows application version and image cache", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^System$/i }).click();
    await expect(page.getByText(/application version/i).first()).toBeVisible();
    await expect(page.getByText(/image cache/i).first()).toBeVisible();
  });

  test("scheduling tab shows the library sync schedule control", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: /^Scheduling$/i }).click();
    await expect(page.getByText(/library sync/i).first()).toBeVisible();
  });
});
