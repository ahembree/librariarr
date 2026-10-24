import { describe, it, expect } from "vitest";
import { authMethodLabel } from "@/lib/auth/auth-method";

describe("authMethodLabel", () => {
  it("names the SSO provider when SSO is linked", () => {
    expect(authMethodLabel({ plexId: "p", ssoEnabled: true, ssoProvider: "Authelia" })).toBe("Authelia");
  });

  it("falls back to Plex, then the local password", () => {
    expect(authMethodLabel({ plexId: "p", ssoEnabled: true, ssoProvider: null })).toBe("Plex");
    expect(authMethodLabel({ plexId: "p", ssoEnabled: false, ssoProvider: "Authelia" })).toBe("Plex");
    expect(authMethodLabel({ plexId: null, ssoEnabled: false, ssoProvider: null })).toBe("Local");
  });
});
