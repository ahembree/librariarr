import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import {
  buildAuthorizationUrl,
  discoverOidc,
  exchangeCodeForToken,
  fetchUserInfo,
  generatePkce,
  generateState,
  resolveRedirectUri,
  type OidcDiscovery,
} from "@/lib/sso/oidc-client";

function makeDiscovery(overrides: Partial<OidcDiscovery> = {}): OidcDiscovery {
  return {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/auth",
    token_endpoint: "https://idp.example.com/token",
    userinfo_endpoint: "https://idp.example.com/userinfo",
    ...overrides,
  };
}

describe("generatePkce", () => {
  it("returns a base64url verifier and matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();

    // RFC 7636: verifier must use only [A-Z][a-z][0-9]-._~ and be 43–128 chars
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);

    const expectedChallenge = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expectedChallenge);
  });

  it("returns different values across calls", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("generateState", () => {
  it("returns base64url-safe string", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeGreaterThan(20);
  });

  it("returns unique values", () => {
    const states = new Set(Array.from({ length: 50 }, () => generateState()));
    expect(states.size).toBe(50);
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes all required OAuth + PKCE params", () => {
    const url = buildAuthorizationUrl({
      discovery: makeDiscovery(),
      clientId: "my-client",
      redirectUri: "https://app.example.com/api/auth/sso/oidc/callback",
      scope: "openid profile email",
      state: "state-123",
      codeChallenge: "challenge-abc",
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://idp.example.com/auth"
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("my-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/auth/sso/oidc/callback"
    );
    expect(parsed.searchParams.get("scope")).toBe("openid profile email");
    expect(parsed.searchParams.get("state")).toBe("state-123");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("preserves authorization_endpoint query params when the IdP includes them", () => {
    const url = buildAuthorizationUrl({
      discovery: makeDiscovery({
        authorization_endpoint: "https://idp.example.com/auth?realm=primary",
      }),
      clientId: "client",
      redirectUri: "https://app/cb",
      scope: "openid",
      state: "s",
      codeChallenge: "c",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("realm")).toBe("primary");
    expect(parsed.searchParams.get("client_id")).toBe("client");
  });
});

describe("resolveRedirectUri", () => {
  it("uses x-forwarded-proto and x-forwarded-host when present", () => {
    const req = new Request("http://internal/api/auth/sso/oidc/login", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "librariarr.example.com",
      },
    });
    expect(resolveRedirectUri(req)).toBe(
      "https://librariarr.example.com/api/auth/sso/oidc/callback"
    );
  });

  it("falls back to host header when x-forwarded-host is absent", () => {
    const req = new Request("http://internal/api/auth/sso/oidc/login", {
      headers: { "x-forwarded-proto": "https", host: "alt.example.com" },
    });
    expect(resolveRedirectUri(req)).toBe(
      "https://alt.example.com/api/auth/sso/oidc/callback"
    );
  });

  it("falls back to request URL when no forwarded headers", () => {
    const req = new Request("https://direct.example.com/api/auth/sso/oidc/login");
    expect(resolveRedirectUri(req)).toBe(
      "https://direct.example.com/api/auth/sso/oidc/callback"
    );
  });
});

describe("discoverOidc", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches .well-known/openid-configuration and trims trailing slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp.example.com/auth",
          token_endpoint: "https://idp.example.com/token",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await discoverOidc("https://idp.example.com///");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://idp.example.com/.well-known/openid-configuration"
    );
    expect(result.issuer).toBe("https://idp.example.com");
  });

  it("throws when discovery response is missing required endpoints", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issuer: "x" }), { status: 200 })
    ) as typeof fetch;

    await expect(discoverOidc("https://x")).rejects.toThrow(/missing required/);
  });

  it("throws on non-2xx responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 })
    ) as typeof fetch;

    await expect(discoverOidc("https://nope.example.com")).rejects.toThrow(
      /OIDC discovery failed \(404\)/
    );
  });
});

describe("exchangeCodeForToken", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "at_123", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs form-encoded body with required grant params", async () => {
    await exchangeCodeForToken({
      discovery: makeDiscovery(),
      clientId: "my-client",
      code: "auth-code",
      redirectUri: "https://app/cb",
      codeVerifier: "verifier-xyz",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://idp.example.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("redirect_uri")).toBe("https://app/cb");
    expect(body.get("client_id")).toBe("my-client");
    expect(body.get("code_verifier")).toBe("verifier-xyz");
  });

  it("sends client_secret_basic Authorization header when secret is provided", async () => {
    await exchangeCodeForToken({
      discovery: makeDiscovery(),
      clientId: "my-client",
      clientSecret: "s3cret",
      code: "c",
      redirectUri: "https://app/cb",
      codeVerifier: "v",
    });

    const init = fetchMock.mock.calls[0][1];
    const expected =
      "Basic " +
      Buffer.from(
        `${encodeURIComponent("my-client")}:${encodeURIComponent("s3cret")}`
      ).toString("base64");
    expect(init.headers.Authorization).toBe(expected);
  });

  it("omits Authorization header for public clients", async () => {
    await exchangeCodeForToken({
      discovery: makeDiscovery(),
      clientId: "public-client",
      code: "c",
      redirectUri: "https://app/cb",
      codeVerifier: "v",
    });
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("throws when the token endpoint returns an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 })
    ) as typeof fetch;

    await expect(
      exchangeCodeForToken({
        discovery: makeDiscovery(),
        clientId: "c",
        code: "bad",
        redirectUri: "https://app/cb",
        codeVerifier: "v",
      })
    ).rejects.toThrow(/Token exchange failed \(400\)/);
  });
});

describe("fetchUserInfo", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the userinfo endpoint with a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sub: "user-1", email: "a@b.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const info = await fetchUserInfo(makeDiscovery(), "at_123");
    expect(info.sub).toBe("user-1");
    expect(info.email).toBe("a@b.com");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://idp.example.com/userinfo");
    expect(init.headers.Authorization).toBe("Bearer at_123");
  });

  it("throws when the provider lacks a userinfo endpoint", async () => {
    await expect(
      fetchUserInfo(makeDiscovery({ userinfo_endpoint: undefined }), "at")
    ).rejects.toThrow(/userinfo endpoint/);
  });

  it("throws when the response omits the sub claim", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ email: "a@b.com" }), { status: 200 })
    ) as typeof fetch;

    await expect(fetchUserInfo(makeDiscovery(), "at")).rejects.toThrow(
      /missing required `sub`/
    );
  });
});
