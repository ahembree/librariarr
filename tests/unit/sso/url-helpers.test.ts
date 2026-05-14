import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { getExternalBaseUrl, isSameOriginRequest } from "@/lib/url";

/**
 * Build a fake NextRequest-shaped object with controllable headers and url.
 * The real NextRequest is a class; for these helpers we only consume
 * `headers.get()` and `request.url`.
 */
function makeRequest(opts: {
  url?: string;
  origin?: string;
  referer?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  host?: string;
}): NextRequest {
  const headers = new Map<string, string>();
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.forwardedHost) headers.set("x-forwarded-host", opts.forwardedHost);
  if (opts.forwardedProto) headers.set("x-forwarded-proto", opts.forwardedProto);
  if (opts.host) headers.set("host", opts.host);

  return {
    url: opts.url ?? "http://librariarr:3000/",
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  } as unknown as NextRequest;
}

describe("getExternalBaseUrl", () => {
  it("uses x-forwarded-host + x-forwarded-proto when present", () => {
    expect(
      getExternalBaseUrl(
        makeRequest({
          url: "http://librariarr:3000/api/x",
          forwardedHost: "app.example.com",
          forwardedProto: "https",
        })
      )
    ).toBe("https://app.example.com");
  });

  it("falls back to host header when x-forwarded-host is absent", () => {
    expect(
      getExternalBaseUrl(
        makeRequest({
          url: "http://librariarr:3000/api/x",
          host: "alt.example.com",
          forwardedProto: "https",
        })
      )
    ).toBe("https://alt.example.com");
  });

  it("falls back to request URL when no headers", () => {
    expect(
      getExternalBaseUrl(
        makeRequest({ url: "https://direct.example.com/api/x" })
      )
    ).toBe("https://direct.example.com");
  });

  it("takes only the first value of chained x-forwarded-host", () => {
    expect(
      getExternalBaseUrl(
        makeRequest({
          url: "http://librariarr:3000/api/x",
          forwardedHost: "app.example.com, internal-host",
          forwardedProto: "https",
        })
      )
    ).toBe("https://app.example.com");
  });
});

describe("isSameOriginRequest", () => {
  it("returns true when no Origin or Referer header is present", () => {
    // Direct address-bar navigations and server-side redirects (e.g. the
    // authenticated layout's redirect to /api/auth/logout) carry no Origin/
    // Referer. Cross-site attacks always carry one — this default permits
    // legitimate flows.
    expect(
      isSameOriginRequest(
        makeRequest({ url: "http://app.example.com/", host: "app.example.com" })
      )
    ).toBe(true);
  });

  it("returns true when Origin matches the external base URL", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          forwardedHost: "app.example.com",
          forwardedProto: "https",
          origin: "https://app.example.com",
        })
      )
    ).toBe(true);
  });

  it("returns false when Origin is from a different host", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          forwardedHost: "app.example.com",
          forwardedProto: "https",
          origin: "https://attacker.example",
        })
      )
    ).toBe(false);
  });

  it("returns false when Origin is from a different scheme", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          forwardedHost: "app.example.com",
          forwardedProto: "https",
          origin: "http://app.example.com",
        })
      )
    ).toBe(false);
  });

  it("uses Referer when Origin is absent", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          host: "app.example.com",
          referer: "http://app.example.com/settings",
        })
      )
    ).toBe(true);
  });

  it("rejects mismatched Referer", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          host: "app.example.com",
          referer: "https://attacker.example/page",
        })
      )
    ).toBe(false);
  });

  it("rejects malformed Referer", () => {
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          host: "app.example.com",
          referer: "not a url at all",
        })
      )
    ).toBe(false);
  });

  it("prefers Origin over Referer when both are present", () => {
    // Origin is authoritative — Referer can be stripped, Origin can't (it's
    // injected by the browser for cross-origin fetches).
    expect(
      isSameOriginRequest(
        makeRequest({
          url: "http://librariarr:3000/",
          host: "app.example.com",
          origin: "https://attacker.example",
          referer: "http://app.example.com/settings",
        })
      )
    ).toBe(false);
  });
});
