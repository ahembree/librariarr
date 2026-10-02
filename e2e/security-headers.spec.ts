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
    expect(headers["x-powered-by"]).toBeUndefined();
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
    });
  }
});
