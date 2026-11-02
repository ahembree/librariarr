import { test, expect } from "@playwright/test";

/**
 * The response headers `next.config.ts` sets, read off the real production
 * server: a unit test of the config object cannot tell whether Next.js
 * actually applies an entry, or which of two entries wins for a path.
 */
test.describe("security headers", () => {
  test("pages carry the app's content security policy and hardening headers", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.status()).toBe(200);
    const headers = res.headers();

    const csp = headers["content-security-policy"] ?? "";
    // Scripts run by the request's nonce (set by `src/proxy.ts`), never eval.
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-eval");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(headers["x-powered-by"]).toBeUndefined();

    // Every script Next.js rendered carries that nonce (tags matched in any
    // case, as a browser parses them), and the next request gets a different one.
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    const again = (await request.get("/login")).headers()["content-security-policy"] ?? "";
    expect(again).not.toContain(`'nonce-${nonce}'`);
  });

  test("the page's own scripts run, and injected inline script does not", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto("/");
    // Next.js' client bootstrap sets `window.next` — it ran under the policy.
    await page.waitForFunction(() => !!(window as unknown as { next?: unknown }).next);
    expect(violations).toEqual([]);

    // The classic injection: markup with an inline event handler. The old
    // policy ('unsafe-inline' alone) ran it; with a nonce in the policy the
    // browser ignores 'unsafe-inline' and refuses it.
    await page.evaluate(() =>
      document.body.insertAdjacentHTML("beforeend", '<img src="/nonexistent.png" onerror="window.__injected = true">'),
    );
    await expect.poll(() => violations.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  });

  test("API responses keep the nonce-less policy", async ({ request }) => {
    const csp = (await request.get("/api/health")).headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("nonce-");
  });

  // Artwork proxies pass through bytes a media server sent; nothing in them
  // may run, even if one is opened directly and is not an image.
  for (const path of [
    "/api/media/some-id/image",
    "/api/v1/media/some-id/image",
    "/api/tools/sessions/image?serverId=x&path=/a",
  ]) {
    test(`${path.split("?")[0]} is served under a policy that runs nothing`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
      // The later entry replaces only the policy; the catch-all's other
      // headers still apply to these paths.
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    });
  }
});
