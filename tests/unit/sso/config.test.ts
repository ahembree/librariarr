import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentSsoIssuer, isSsoOverrideActive, isSsoUsable, ssoUnusableReason, type SsoSettings } from "@/lib/sso/config";

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
    const originalSecret = process.env.FORWARD_AUTH_SECRET;
    beforeEach(() => {
      process.env.FORWARD_AUTH_SECRET = "proxy-secret";
    });
    afterEach(() => {
      if (originalSecret === undefined) delete process.env.FORWARD_AUTH_SECRET;
      else process.env.FORWARD_AUTH_SECRET = originalSecret;
    });

    it("returns true when the user header and FORWARD_AUTH_SECRET are set", () => {
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

    // Without the secret a request cannot prove it came through the proxy, so
    // the identity header proves nothing (forward-secret.ts).
    it("returns false while FORWARD_AUTH_SECRET is unset or empty", () => {
      const settings = makeSettings({ ssoMode: "FORWARD_AUTH" });
      delete process.env.FORWARD_AUTH_SECRET;
      expect(isSsoUsable(settings)).toBe(false);
      expect(ssoUnusableReason(settings)).toMatch(/FORWARD_AUTH_SECRET/);
      process.env.FORWARD_AUTH_SECRET = "";
      expect(isSsoUsable(settings)).toBe(false);
    });
  });

  // The OIDC client relies on TLS to authenticate the issuer (issuer-url.ts).
  describe("OIDC issuer scheme", () => {
    const originalAllow = process.env.OIDC_ALLOW_INSECURE_HTTP;
    afterEach(() => {
      if (originalAllow === undefined) delete process.env.OIDC_ALLOW_INSECURE_HTTP;
      else process.env.OIDC_ALLOW_INSECURE_HTTP = originalAllow;
    });

    it("refuses an http:// issuer on a network host", () => {
      delete process.env.OIDC_ALLOW_INSECURE_HTTP;
      const settings = makeSettings({ oidcIssuer: "http://idp.lan" });
      expect(isSsoUsable(settings)).toBe(false);
      expect(ssoUnusableReason(settings)).toMatch(/https/);
    });

    it("accepts http:// on loopback, and anywhere under OIDC_ALLOW_INSECURE_HTTP", () => {
      delete process.env.OIDC_ALLOW_INSECURE_HTTP;
      expect(isSsoUsable(makeSettings({ oidcIssuer: "http://localhost:9000" }))).toBe(true);
      process.env.OIDC_ALLOW_INSECURE_HTTP = "true";
      expect(isSsoUsable(makeSettings({ oidcIssuer: "http://idp.lan" }))).toBe(true);
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
