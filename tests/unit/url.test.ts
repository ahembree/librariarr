import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { getExternalBaseUrl, isTrustedMutationOrigin } from "@/lib/url";

function makeRequest(
  url: string,
  headers?: Record<string, string>
): NextRequest {
  return new NextRequest(new URL(url), {
    headers: headers ?? {},
  });
}

describe("getExternalBaseUrl", () => {
  // -- Behind a reverse proxy --

  it("HTTPS proxy with both forwarded headers", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/auth/logout", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.example.com",
    });
    expect(getExternalBaseUrl(req)).toBe("https://app.example.com");
  });

  it("HTTP proxy with both forwarded headers", () => {
    const req = makeRequest("http://127.0.0.1:3000/dashboard", {
      "x-forwarded-proto": "http",
      "x-forwarded-host": "app.local:8080",
    });
    expect(getExternalBaseUrl(req)).toBe("http://app.local:8080");
  });

  it("proxy sets x-forwarded-proto only (host from Host header)", () => {
    const req = makeRequest("http://127.0.0.1:3000/dashboard", {
      "x-forwarded-proto": "https",
      host: "app.example.com",
    });
    expect(getExternalBaseUrl(req)).toBe("https://app.example.com");
  });

  it("proxy sets x-forwarded-host only (proto from request URL)", () => {
    const req = makeRequest("http://127.0.0.1:3000/dashboard", {
      "x-forwarded-host": "app.example.com",
    });
    expect(getExternalBaseUrl(req)).toBe("http://app.example.com");
  });

  it("chained proxies — takes first value from comma-separated lists", () => {
    const req = makeRequest("http://127.0.0.1:3000/dashboard", {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "external.com, internal-proxy.local",
    });
    expect(getExternalBaseUrl(req)).toBe("https://external.com");
  });

  // -- Direct access (no proxy) --

  it("direct access via localhost", () => {
    const req = makeRequest("http://localhost:3000/dashboard", {
      host: "localhost:3000",
    });
    expect(getExternalBaseUrl(req)).toBe("http://localhost:3000");
  });

  it("direct access via LAN IP", () => {
    const req = makeRequest("http://192.168.1.50:3000/dashboard", {
      host: "192.168.1.50:3000",
    });
    expect(getExternalBaseUrl(req)).toBe("http://192.168.1.50:3000");
  });

  it("no explicit Host header — NextRequest synthesises one from the URL", () => {
    const req = makeRequest("http://127.0.0.1:3000/dashboard");
    // NextRequest always synthesises a host header from the URL, so the
    // fallback to parsing request.url.host is never actually reached.
    // We just verify the result is a valid base URL derived from the request.
    const result = getExternalBaseUrl(req);
    expect(result).toMatch(/^http:\/\/.+:3000$/);
  });
});

describe("isTrustedMutationOrigin (CSRF guard for /api mutations)", () => {
  it("accepts an Origin whose host matches the request host", () => {
    const req = makeRequest("http://localhost:3000/api/settings/x", {
      host: "localhost:3000",
      origin: "http://localhost:3000",
    });
    expect(isTrustedMutationOrigin(req)).toBe(true);
  });

  it("rejects an Origin on a different host", () => {
    const req = makeRequest("http://localhost:3000/api/settings/x", {
      host: "localhost:3000",
      origin: "http://evil.example",
    });
    expect(isTrustedMutationOrigin(req)).toBe(false);
  });

  it("rejects a same-site sibling subdomain (what SameSite=Lax alone lets through)", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/settings/x", {
      "x-forwarded-host": "librariarr.home.example",
      "x-forwarded-proto": "https",
      origin: "https://grafana.home.example",
    });
    expect(isTrustedMutationOrigin(req)).toBe(false);
  });

  it("compares by host, so a missing x-forwarded-proto does not break the app's own UI", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/settings/x", {
      "x-forwarded-host": "app.example.com",
      origin: "https://app.example.com",
    });
    expect(isTrustedMutationOrigin(req)).toBe(true);
  });

  it("falls back to Referer when Origin is absent", () => {
    const ok = makeRequest("http://localhost:3000/api/x", {
      host: "localhost:3000",
      referer: "http://localhost:3000/settings",
    });
    const bad = makeRequest("http://localhost:3000/api/x", {
      host: "localhost:3000",
      referer: "http://evil.example/page",
    });
    expect(isTrustedMutationOrigin(ok)).toBe(true);
    expect(isTrustedMutationOrigin(bad)).toBe(false);
  });

  it("allows requests carrying neither Origin nor Referer (non-browser clients)", () => {
    const req = makeRequest("http://localhost:3000/api/x", { host: "localhost:3000" });
    expect(isTrustedMutationOrigin(req)).toBe(true);
  });

  it("rejects an unparseable Origin", () => {
    const req = makeRequest("http://localhost:3000/api/x", {
      host: "localhost:3000",
      origin: "null",
    });
    expect(isTrustedMutationOrigin(req)).toBe(false);
  });

  it("host comparison is case-insensitive", () => {
    const req = makeRequest("http://localhost:3000/api/x", {
      host: "LocalHost:3000",
      origin: "http://localhost:3000",
    });
    expect(isTrustedMutationOrigin(req)).toBe(true);
  });
});
