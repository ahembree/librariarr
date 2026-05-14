import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentSsoIssuer, isSsoOverrideActive, isSsoUsable, type SsoSettings } from "@/lib/sso/config";

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

describe("isSsoOverrideActive", () => {
  const originalValue = process.env.SSO_DISABLE_OVERRIDE;

  beforeEach(() => {
    delete process.env.SSO_DISABLE_OVERRIDE;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.SSO_DISABLE_OVERRIDE;
    } else {
      process.env.SSO_DISABLE_OVERRIDE = originalValue;
    }
  });

  it("returns false when the env var is unset", () => {
    expect(isSsoOverrideActive()).toBe(false);
  });

  it("returns false for an empty string", () => {
    process.env.SSO_DISABLE_OVERRIDE = "";
    expect(isSsoOverrideActive()).toBe(false);
  });

  it("returns false for unrecognized values", () => {
    process.env.SSO_DISABLE_OVERRIDE = "false";
    expect(isSsoOverrideActive()).toBe(false);

    process.env.SSO_DISABLE_OVERRIDE = "0";
    expect(isSsoOverrideActive()).toBe(false);

    process.env.SSO_DISABLE_OVERRIDE = "no";
    expect(isSsoOverrideActive()).toBe(false);

    process.env.SSO_DISABLE_OVERRIDE = "maybe";
    expect(isSsoOverrideActive()).toBe(false);
  });

  it("recognizes 'true' (case-insensitive)", () => {
    process.env.SSO_DISABLE_OVERRIDE = "true";
    expect(isSsoOverrideActive()).toBe(true);

    process.env.SSO_DISABLE_OVERRIDE = "TRUE";
    expect(isSsoOverrideActive()).toBe(true);

    process.env.SSO_DISABLE_OVERRIDE = "True";
    expect(isSsoOverrideActive()).toBe(true);
  });

  it("recognizes '1' and 'yes'", () => {
    process.env.SSO_DISABLE_OVERRIDE = "1";
    expect(isSsoOverrideActive()).toBe(true);

    process.env.SSO_DISABLE_OVERRIDE = "yes";
    expect(isSsoOverrideActive()).toBe(true);

    process.env.SSO_DISABLE_OVERRIDE = "YES";
    expect(isSsoOverrideActive()).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    process.env.SSO_DISABLE_OVERRIDE = "  true  ";
    expect(isSsoOverrideActive()).toBe(true);
  });
});

describe("currentSsoIssuer", () => {
  it("returns null when settings are null", () => {
    expect(currentSsoIssuer(null)).toBeNull();
  });

  it("returns the OIDC issuer URL with trailing slashes stripped", () => {
    expect(
      currentSsoIssuer(
        makeSettings({ ssoMode: "OIDC", oidcIssuer: "https://idp.example.com/" })
      )
    ).toBe("https://idp.example.com");
    expect(
      currentSsoIssuer(
        makeSettings({ ssoMode: "OIDC", oidcIssuer: "https://idp.example.com" })
      )
    ).toBe("https://idp.example.com");
    expect(
      currentSsoIssuer(
        makeSettings({ ssoMode: "OIDC", oidcIssuer: "https://idp.example.com///" })
      )
    ).toBe("https://idp.example.com");
  });

  it("returns null when OIDC mode but no issuer configured", () => {
    expect(
      currentSsoIssuer(makeSettings({ ssoMode: "OIDC", oidcIssuer: null }))
    ).toBeNull();
  });

  it("returns the literal 'forward-auth' sentinel for forward-auth mode", () => {
    expect(
      currentSsoIssuer(makeSettings({ ssoMode: "FORWARD_AUTH" }))
    ).toBe("forward-auth");
    // Even when OIDC fields are also set, forward-auth mode wins.
    expect(
      currentSsoIssuer(
        makeSettings({
          ssoMode: "FORWARD_AUTH",
          oidcIssuer: "https://oidc.example.com",
        })
      )
    ).toBe("forward-auth");
  });

  it("normalization round-trips with discoverOidc's normalization", () => {
    // discoverOidc strips trailing slashes the same way; the two helpers must
    // agree so the issuer compared at login time matches what was stored.
    const linkTime = currentSsoIssuer(
      makeSettings({ ssoMode: "OIDC", oidcIssuer: "https://idp.example.com/" })
    );
    const loginTime = currentSsoIssuer(
      makeSettings({ ssoMode: "OIDC", oidcIssuer: "https://idp.example.com" })
    );
    expect(linkTime).toBe(loginTime);
  });
});
