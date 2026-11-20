import { describe, expect, it } from "vitest";
import {
  OIDC_AUTH_TIME_SKEW_MS,
  OIDC_HANDSHAKE_TTL_MS,
  allowsUnverifiedOidcReauth,
  beginOidcHandshake,
  clearOidcHandshake,
  isOidcHandshakeFresh,
  reauthFreshness,
  type OidcHandshakeFields,
} from "@/lib/sso/handshake";

describe("the OIDC handshake a session carries", () => {
  it("is written with the time it began, and replaces whatever flow was left behind", () => {
    const session: OidcHandshakeFields = { oidcFlow: "link", oidcState: "old", oidcVerifier: "old", oidcStartedAt: 1 };
    const before = Date.now();
    beginOidcHandshake(session, { state: "s", verifier: "v" });
    expect(session.oidcState).toBe("s");
    expect(session.oidcVerifier).toBe("v");
    expect(session.oidcFlow).toBeUndefined();
    expect(session.oidcStartedAt).toBeGreaterThanOrEqual(before);

    beginOidcHandshake(session, { state: "s2", verifier: "v2", flow: "reauth" });
    expect(session.oidcFlow).toBe("reauth");
  });

  it("is cleared whole", () => {
    const session: OidcHandshakeFields = {};
    beginOidcHandshake(session, { state: "s", verifier: "v", flow: "link" });
    clearOidcHandshake(session);
    expect(session).toEqual({
      oidcState: undefined,
      oidcVerifier: undefined,
      oidcFlow: undefined,
      oidcStartedAt: undefined,
    });
  });

  it("may be completed for ten minutes", () => {
    const now = 1_800_000_000_000;
    expect(OIDC_HANDSHAKE_TTL_MS).toBe(10 * 60 * 1000);
    expect(isOidcHandshakeFresh(now, now)).toBe(true);
    expect(isOidcHandshakeFresh(now - OIDC_HANDSHAKE_TTL_MS, now)).toBe(true);
    expect(isOidcHandshakeFresh(now - OIDC_HANDSHAKE_TTL_MS - 1, now)).toBe(false);
    // A cookie from before handshakes were timed, and a start in the future.
    expect(isOidcHandshakeFresh(undefined, now)).toBe(false);
    expect(isOidcHandshakeFresh(now + 1, now)).toBe(false);
  });
});

describe("reauthFreshness", () => {
  const started = 1_800_000_000_000;
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("is fresh when the provider signed the user in after the confirmation began", () => {
    expect(reauthFreshness(seconds(started) + 30, started)).toBe("fresh");
  });

  it("allows for a provider clock a few minutes behind, and no more", () => {
    expect(reauthFreshness(seconds(started - OIDC_AUTH_TIME_SKEW_MS + 1000), started)).toBe("fresh");
    expect(reauthFreshness(seconds(started - OIDC_AUTH_TIME_SKEW_MS - 1000), started)).toBe("stale");
  });

  it("is stale for a session that began long before", () => {
    expect(reauthFreshness(seconds(started) - 86_400, started)).toBe("stale");
  });

  it("is unknown when the provider did not say", () => {
    expect(reauthFreshness(undefined, started)).toBe("unknown");
    expect(reauthFreshness(Number.NaN, started)).toBe("unknown");
  });

  it("is stale when the handshake has no start to compare with", () => {
    expect(reauthFreshness(seconds(started), undefined)).toBe("stale");
  });
});

describe("allowsUnverifiedOidcReauth", () => {
  it("is off unless OIDC_REAUTH_ALLOW_UNVERIFIED is truthy", () => {
    expect(allowsUnverifiedOidcReauth({})).toBe(false);
    expect(allowsUnverifiedOidcReauth({ OIDC_REAUTH_ALLOW_UNVERIFIED: "false" })).toBe(false);
    expect(allowsUnverifiedOidcReauth({ OIDC_REAUTH_ALLOW_UNVERIFIED: "true" })).toBe(true);
    expect(allowsUnverifiedOidcReauth({ OIDC_REAUTH_ALLOW_UNVERIFIED: " YES " })).toBe(true);
  });
});
