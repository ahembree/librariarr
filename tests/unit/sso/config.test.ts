import { describe, expect, it } from "vitest";
import { isSsoUsable, type SsoSettings } from "@/lib/sso/config";

function makeSettings(overrides: Partial<SsoSettings> = {}): SsoSettings {
  return {
    ssoEnabled: true,
    ssoMode: "OIDC",
    oidcIssuer: "https://idp.example.com",
    oidcClientId: "client",
    oidcClientSecret: null,
    oidcScopes: "openid profile email",
    oidcUsernameClaim: "preferred_username",
    forwardAuthUserHeader: "Remote-User",
    forwardAuthEmailHeader: "Remote-Email",
    forwardAuthNameHeader: "Remote-Name",
    ...overrides,
  };
}

describe("isSsoUsable", () => {
  it("returns false when settings are null", () => {
    expect(isSsoUsable(null)).toBe(false);
  });

  it("returns false when ssoEnabled is false", () => {
    expect(isSsoUsable(makeSettings({ ssoEnabled: false }))).toBe(false);
  });

  describe("OIDC mode", () => {
    it("returns true when issuer and client ID are both set", () => {
      expect(isSsoUsable(makeSettings())).toBe(true);
    });

    it("returns false when issuer is missing", () => {
      expect(
        isSsoUsable(makeSettings({ oidcIssuer: null }))
      ).toBe(false);
    });

    it("returns false when client ID is missing", () => {
      expect(
        isSsoUsable(makeSettings({ oidcClientId: null }))
      ).toBe(false);
    });

    it("does not require a client secret (public clients are valid)", () => {
      expect(
        isSsoUsable(makeSettings({ oidcClientSecret: null }))
      ).toBe(true);
    });
  });

  describe("FORWARD_AUTH mode", () => {
    it("returns true when the user header is set", () => {
      expect(
        isSsoUsable(
          makeSettings({
            ssoMode: "FORWARD_AUTH",
            // OIDC fields can be empty when not in OIDC mode
            oidcIssuer: null,
            oidcClientId: null,
          })
        )
      ).toBe(true);
    });

    it("returns false when the user header is empty", () => {
      expect(
        isSsoUsable(
          makeSettings({
            ssoMode: "FORWARD_AUTH",
            forwardAuthUserHeader: "",
          })
        )
      ).toBe(false);
    });
  });
});
