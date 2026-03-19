import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { getExternalBaseUrl } from "@/lib/url";

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
