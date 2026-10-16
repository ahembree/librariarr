import { test, expect, type Page, type Request } from "@playwright/test";

/**
 * Onboarding with the media-server side stubbed (no real Plex, Jellyfin or
 * plex.tv is ever contacted).
 *
 * - Jellyfin/Emby: Connect only TESTS the connection (`/api/servers/test`);
 *   the server is created once, on Select Libraries. Connect used to create
 *   it, and since the form stays editable, editing a field and pressing
 *   Connect again created a second server.
 * - Plex: the Back button is hidden only when a Plex token was found on
 *   arrival. A local account that links Plex during onboarding keeps it, so it
 *   can still go back and add a Jellyfin or Emby server.
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

const PLEX_SERVER = {
  name: "Plex Box",
  clientIdentifier: "plex-box-1",
  product: "Plex Media Server",
  productVersion: "1.40.0",
  platform: "Linux",
  connections: [{ protocol: "http", address: "10.0.0.5", port: 32400, uri: "http://10.0.0.5:32400", local: true }],
};

/** No server exists yet, and the account holds no Plex token until `linked()`. */
async function stubServers(page: Page) {
  let linked = false;
  await page.route(isPath("/api/auth/plex/servers"), (route) =>
    linked
      ? route.fulfill({ json: { servers: [PLEX_SERVER] } })
      : route.fulfill({ status: 400, json: { error: "No Plex token" } }),
  );
  return { link: () => { linked = true; } };
}

test.describe("onboarding — Jellyfin", () => {
  test("Connect only tests; the server is created once, on Select Libraries", async ({ page }) => {
    await stubServers(page);
    const tests: Request[] = [];
    const creates: Request[] = [];
    await page.route(isPath("/api/servers/test"), (route) => {
      tests.push(route.request());
      return route.fulfill({ json: { ok: true, error: null, serverName: "Jellyfin" } });
    });
    await page.route(isPath("/api/servers"), (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { servers: [] } });
      creates.push(route.request());
      return route.fulfill({ status: 201, json: { server: { id: "srv-jf" } } });
    });
    await page.route(isPath("/api/servers/srv-jf/libraries"), (route) =>
      route.fulfill({
        json: { libraries: [{ key: "lib-1", title: "Films", type: "movie", enabled: true, exists: false }] },
      }),
    );

    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Jellyfin/ }).click();
    await page.locator("#manual-url").fill("http://jellyfin.lan:8096");
    await page.locator("#manual-apikey").fill("jf-api-key");

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connection successful")).toBeVisible();

    // An edit after a successful connect brings Connect back; pressing it
    // again must not add the server a second time.
    await page.locator("#manual-name").fill("Living Room");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connection successful")).toBeVisible();
    expect(tests).toHaveLength(2);
    expect(creates).toHaveLength(0);

    await page.getByRole("button", { name: "Select Libraries" }).click();
    await expect(page.getByText("Films")).toBeVisible();
    expect(creates).toHaveLength(1);
    expect(creates[0].postDataJSON()).toMatchObject({
      name: "Living Room",
      url: "http://jellyfin.lan:8096",
      accessToken: "jf-api-key",
      type: "JELLYFIN",
    });
  });

  test("a server that cannot be created leaves the form with the reason", async ({ page }) => {
    await stubServers(page);
    await page.route(isPath("/api/servers/test"), (route) =>
      route.fulfill({ json: { ok: true, error: null, serverName: "Jellyfin" } }),
    );
    await page.route(isPath("/api/servers"), (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { servers: [] } })
        : route.fulfill({ status: 400, json: { error: "Failed to connect to server", detail: "connection refused" } }),
    );

    await page.goto("/onboarding");
    await page.getByRole("button", { name: /Jellyfin/ }).click();
    await page.locator("#manual-url").fill("http://jellyfin.lan:8096");
    await page.locator("#manual-apikey").fill("jf-api-key");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Select Libraries" }).click();

    await expect(page.getByText("connection refused")).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Libraries" })).toBeEnabled();
  });
});

test.describe("onboarding — Plex linked during onboarding", () => {
  test("keeps the Back button, so Jellyfin and Emby stay reachable", async ({ page }) => {
    const servers = await stubServers(page);
    await page.route(isPath("/api/servers"), (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: { servers: [] } }) : route.continue(),
    );
    // The OAuth popup: a stand-in window, so nothing navigates to plex.tv.
    await page.addInitScript(() => {
      window.open = () =>
        ({ closed: false, close() { (this as { closed: boolean }).closed = true; }, location: { href: "" } }) as unknown as Window;
    });
    await page.route(isPath("/api/auth/plex/init"), (route) =>
      route.fulfill({
        json: { pinId: 42, code: "pin-code", clientId: "client-1", product: "Librariarr", version: "1.0.0", authUrl: "/login/plex/loading" },
      }),
    );
    // The PIN poll goes to plex.tv from the browser; answered here, never sent.
    await page.context().route("https://plex.tv/**", (route) =>
      route.fulfill({
        status: route.request().method() === "OPTIONS" ? 204 : 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
        json: route.request().method() === "OPTIONS" ? undefined : { id: 42, authToken: "plex-token" },
      }),
    );
    await page.route(isPath("/api/auth/plex/link"), (route) => {
      servers.link();
      return route.fulfill({ json: { linked: true } });
    });

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Connect a Media Server" })).toBeVisible();

    await page.getByRole("button", { name: /Auto-discover servers from your Plex account/ }).click();
    await expect(page.getByRole("heading", { name: "Select Your Plex Servers" })).toBeVisible();
    await expect(page.getByText("Plex Box")).toBeVisible();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Connect a Media Server" })).toBeVisible();
  });
});
