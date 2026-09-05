import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function req(url: string, init?: { method?: string; headers?: Record<string, string>; cookie?: boolean }) {
  const headers = new Headers(init?.headers ?? {});
  if (init?.cookie) headers.set("cookie", "librariarr_session=sealed");
  return new NextRequest(new URL(url), { method: init?.method ?? "GET", headers });
}

/**
 * The proxy is the single place the CSRF origin check runs for state-changing
 * `/api/*` requests. `SameSite=Lax` already blocks most cross-site cookie
 * sends; this closes the same-site-sibling case and the browsers with uneven
 * SameSite enforcement.
 */
describe("proxy — CSRF origin check on /api mutations", () => {
  it("rejects a POST whose Origin is another host", async () => {
    const res = proxy(
      req("http://localhost:3000/api/settings/accent-color", {
        method: "POST",
        cookie: true,
        headers: { host: "localhost:3000", origin: "http://evil.example" },
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-site request rejected" });
  });

  it.each(["PUT", "DELETE", "PATCH"])("rejects a cross-site %s too", (method) => {
    const res = proxy(
      req("http://localhost:3000/api/x", {
        method,
        headers: { host: "localhost:3000", origin: "http://evil.example" },
      })
    );
    expect(res.status).toBe(403);
  });

  it("passes a same-origin POST through", () => {
    const res = proxy(
      req("http://localhost:3000/api/settings/accent-color", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes a POST with no Origin/Referer through (curl, scripts)", () => {
    const res = proxy(
      req("http://localhost:3000/api/x", { method: "POST", headers: { host: "localhost:3000" } })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("never applies the check to GET/HEAD/OPTIONS", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = proxy(
        req("http://localhost:3000/api/servers", {
          method,
          headers: { host: "localhost:3000", origin: "http://evil.example" },
        })
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("honours the proxy's forwarded host when deciding what 'same origin' is", () => {
    const res = proxy(
      req("http://127.0.0.1:3000/api/x", {
        method: "PUT",
        headers: {
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
          origin: "https://app.example.com",
        },
      })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy — page auth gate", () => {
  it("redirects an unauthenticated page request to /login", () => {
    const res = proxy(req("http://localhost:3000/library/movies", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("lets a page request with a session cookie through", () => {
    const res = proxy(
      req("http://localhost:3000/library/movies", { cookie: true, headers: { host: "localhost:3000" } })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not redirect the login page itself", () => {
    const res = proxy(req("http://localhost:3000/login", { headers: { host: "localhost:3000" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
