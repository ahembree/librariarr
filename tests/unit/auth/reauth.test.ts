import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUser, mockFindSettings, mockGetSso, mockOverride } = vi.hoisted(() => ({
  mockFindUser: vi.fn(),
  mockFindSettings: vi.fn(),
  mockGetSso: vi.fn(),
  mockOverride: vi.fn(() => false),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mockFindUser },
    appSettings: { findFirst: mockFindSettings },
  },
}));

vi.mock("@/lib/sso/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sso/config")>()),
  getSsoSettings: mockGetSso,
  isSsoOverrideActive: mockOverride,
}));

import {
  loadReauthContext,
  reauthNonceFromState,
  reauthRequired,
  ssoIdentityMatches,
  ssoLinkedToIssuer,
} from "@/lib/auth/reauth";

const ISSUER = "https://idp.example.com";

const oidc = (overrides: Record<string, unknown> = {}) => ({
  ssoEnabled: true,
  ssoMode: "OIDC",
  oidcIssuer: `${ISSUER}/`,
  oidcClientId: "client",
  oidcClientSecret: null,
  oidcScopes: "openid",
  oidcUsernameClaim: "preferred_username",
  forwardAuthUserHeader: "Remote-User",
  forwardAuthEmailHeader: "Remote-Email",
  forwardAuthNameHeader: "Remote-Name",
  ...overrides,
});

const user = (overrides: Record<string, unknown> = {}) => ({
  plexId: null,
  passwordHash: null,
  ssoEnabled: false,
  ssoSubject: null,
  ssoIssuer: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockOverride.mockReturnValue(false);
  mockFindSettings.mockResolvedValue(null);
  mockGetSso.mockResolvedValue(null);
});

describe("ssoLinkedToIssuer / ssoIdentityMatches", () => {
  const linked = { ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: ISSUER };

  it("accepts the linked subject under the configured issuer", () => {
    expect(ssoLinkedToIssuer(linked, ISSUER)).toBe(true);
    expect(ssoIdentityMatches(linked, "sub-1", ISSUER)).toBe(true);
  });

  it("accepts a legacy link with no stored issuer, as login does", () => {
    expect(ssoIdentityMatches({ ...linked, ssoIssuer: null }, "sub-1", ISSUER)).toBe(true);
  });

  it("refuses another subject, another issuer, a disabled or missing link, or no issuer", () => {
    expect(ssoIdentityMatches(linked, "sub-2", ISSUER)).toBe(false);
    expect(ssoIdentityMatches(linked, "sub-1", "https://other.example.com")).toBe(false);
    expect(ssoIdentityMatches({ ...linked, ssoEnabled: false }, "sub-1", ISSUER)).toBe(false);
    expect(ssoIdentityMatches({ ...linked, ssoSubject: null }, "sub-1", ISSUER)).toBe(false);
    expect(ssoLinkedToIssuer(linked, null)).toBe(false);
  });
});

describe("loadReauthContext", () => {
  it("offers nothing for a user that is gone", async () => {
    mockFindUser.mockResolvedValue(null);
    expect((await loadReauthContext("u")).methods).toEqual([]);
  });

  it("offers Plex for a linked Plex account while Plex sign-in is allowed", async () => {
    mockFindUser.mockResolvedValue(user({ plexId: "42" }));
    expect((await loadReauthContext("u")).methods).toEqual(["plex"]);

    mockFindSettings.mockResolvedValue({ plexLoginEnabled: true });
    expect((await loadReauthContext("u")).methods).toEqual(["plex"]);
  });

  // A household sharing one Plex account is why Plex sign-in can be off.
  it("does not offer Plex while Plex sign-in is off, unless SSO_DISABLE_OVERRIDE re-opens it", async () => {
    mockFindUser.mockResolvedValue(user({ plexId: "42" }));
    mockFindSettings.mockResolvedValue({ plexLoginEnabled: false });
    expect((await loadReauthContext("u")).methods).toEqual([]);

    mockOverride.mockReturnValue(true);
    expect((await loadReauthContext("u")).methods).toEqual(["plex"]);
  });

  it("offers OIDC or the proxy for an identity linked under the usable SSO config", async () => {
    mockFindUser.mockResolvedValue(user({ ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: ISSUER }));
    mockGetSso.mockResolvedValue(oidc());
    const context = await loadReauthContext("u");
    expect(context.methods).toEqual(["oidc"]);
    expect(context.sso?.ssoMode).toBe("OIDC");

    mockFindUser.mockResolvedValue(user({ ssoEnabled: true, ssoSubject: "alice", ssoIssuer: "forward-auth" }));
    mockGetSso.mockResolvedValue(oidc({ ssoMode: "FORWARD_AUTH" }));
    expect((await loadReauthContext("u")).methods).toEqual(["forward"]);
  });

  it("does not offer SSO when it is off, unconfigured, or linked under another issuer", async () => {
    mockFindUser.mockResolvedValue(user({ ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: ISSUER }));
    mockGetSso.mockResolvedValue(oidc({ ssoEnabled: false }));
    expect((await loadReauthContext("u")).methods).toEqual([]);

    mockGetSso.mockResolvedValue(oidc({ oidcClientId: null }));
    expect((await loadReauthContext("u")).methods).toEqual([]);

    mockGetSso.mockResolvedValue(oidc({ oidcIssuer: "https://other.example.com" }));
    expect((await loadReauthContext("u")).methods).toEqual([]);
  });

  // The password is accepted for nothing while password sign-in is off —
  // local login off, or SSO replacing the local form — the login's own rule.
  it("offers the password only while password sign-in is on, listed last", async () => {
    mockFindUser.mockResolvedValue(
      user({ plexId: "42", passwordHash: "hash", ssoEnabled: true, ssoSubject: "sub-1", ssoIssuer: ISSUER }),
    );
    mockFindSettings.mockResolvedValue({ plexLoginEnabled: true, localAuthEnabled: true });
    expect((await loadReauthContext("u")).methods).toEqual(["plex", "password"]);

    // SSO usable: it replaces the local form, so no password.
    mockGetSso.mockResolvedValue(oidc());
    expect((await loadReauthContext("u")).methods).toEqual(["plex", "oidc"]);

    // Local login off.
    mockGetSso.mockResolvedValue(null);
    mockFindSettings.mockResolvedValue({ plexLoginEnabled: true, localAuthEnabled: false });
    expect((await loadReauthContext("u")).methods).toEqual(["plex"]);

    // SSO_DISABLE_OVERRIDE re-opens password sign-in, as it does at login.
    mockOverride.mockReturnValue(true);
    expect((await loadReauthContext("u")).methods).toEqual(["plex", "password"]);
  });
});

describe("reauthRequired", () => {
  it("names the methods and asks to confirm in place", async () => {
    mockFindUser.mockResolvedValue(user({ plexId: "42" }));
    const res = await reauthRequired("u", "Linking a Plex account");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Linking a Plex account needs a sign-in from the last 15 minutes. Confirm it's you to continue.",
      code: "reauth_required",
      methods: ["plex"],
    });
  });

  it("falls back to signing in again when nothing can confirm in place", async () => {
    mockFindUser.mockResolvedValue(user());
    const body = (await (await reauthRequired("u", "Setting a password")).json()) as {
      error: string;
      methods: string[];
    };
    expect(body.methods).toEqual([]);
    expect(body.error).toMatch(/sign out, sign back in/i);
  });

  // Under SSO, nothing to confirm with means SSO does not recognise the link
  // (linked under another issuer, with password and Plex sign-in off):
  // signing out would lock the admin out, so never advise it there.
  it("warns against signing out when SSO is what the login page offers", async () => {
    mockGetSso.mockResolvedValue(oidc({ oidcIssuer: "https://other.example.com" }));
    mockFindSettings.mockResolvedValue({ plexLoginEnabled: false, localAuthEnabled: true });
    mockFindUser.mockResolvedValue(
      user({ plexId: "42", passwordHash: "h", ssoEnabled: true, ssoSubject: "s", ssoIssuer: ISSUER }),
    );
    const body = (await (await reauthRequired("u", "Turning off SSO")).json()) as {
      error: string;
      methods: string[];
    };
    expect(body.methods).toEqual([]);
    expect(body.error).toMatch(/don't sign out/i);
    expect(body.error).toMatch(/SSO_DISABLE_OVERRIDE/);
  });
});

describe("reauthNonceFromState", () => {
  it("reads the attempt nonce after the last dot", () => {
    expect(reauthNonceFromState("randomPart.attempt-nonce-0123456789")).toBe("attempt-nonce-0123456789");
  });

  it("finds none in a plain state, a malformed nonce, or no state", () => {
    expect(reauthNonceFromState("randomPartWithoutNonce")).toBeUndefined();
    expect(reauthNonceFromState("random.short")).toBeUndefined();
    expect(reauthNonceFromState("random.not a nonce!!!!!!!!!")).toBeUndefined();
    expect(reauthNonceFromState(null)).toBeUndefined();
  });
});
