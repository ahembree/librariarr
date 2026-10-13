import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findFirst: findFirstMock,
    },
  },
}));

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLoggerError },
}));

import { getSsoSettings } from "@/lib/sso/config";

const FULL_ROW = {
  ssoEnabled: true,
  ssoMode: "OIDC",
  oidcIssuer: "https://idp.example.com",
  oidcClientId: "client",
  oidcClientSecret: "secret",
  oidcScopes: "openid profile email",
  oidcUsernameClaim: "preferred_username",
  forwardAuthUserHeader: "Remote-User",
  forwardAuthEmailHeader: "Remote-Email",
  forwardAuthNameHeader: "Remote-Name",
};

describe("getSsoSettings", () => {
  const originalValue = process.env.SSO_DISABLE_OVERRIDE;

  beforeEach(() => {
    delete process.env.SSO_DISABLE_OVERRIDE;
    findFirstMock.mockReset();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.SSO_DISABLE_OVERRIDE;
    } else {
      process.env.SSO_DISABLE_OVERRIDE = originalValue;
    }
  });

  it("returns null when no AppSettings row exists", async () => {
    findFirstMock.mockResolvedValue(null);
    expect(await getSsoSettings()).toBeNull();
  });

  it("returns the stored config unchanged when override is not set", async () => {
    findFirstMock.mockResolvedValue(FULL_ROW);
    const result = await getSsoSettings();
    expect(result).toEqual({ ...FULL_ROW, ssoMode: "OIDC" });
  });

  it("normalizes an unrecognized ssoMode value to OIDC", async () => {
    findFirstMock.mockResolvedValue({ ...FULL_ROW, ssoMode: "SAML" });
    const result = await getSsoSettings();
    expect(result?.ssoMode).toBe("OIDC");
  });

  it("preserves FORWARD_AUTH mode", async () => {
    findFirstMock.mockResolvedValue({ ...FULL_ROW, ssoMode: "FORWARD_AUTH" });
    const result = await getSsoSettings();
    expect(result?.ssoMode).toBe("FORWARD_AUTH");
  });

  it("forces ssoEnabled false when SSO_DISABLE_OVERRIDE is truthy", async () => {
    findFirstMock.mockResolvedValue(FULL_ROW);
    process.env.SSO_DISABLE_OVERRIDE = "true";
    const result = await getSsoSettings();
    expect(result?.ssoEnabled).toBe(false);
    // The rest of the stored config is preserved
    expect(result?.oidcIssuer).toBe(FULL_ROW.oidcIssuer);
    expect(result?.oidcClientId).toBe(FULL_ROW.oidcClientId);
  });

  it("ignores SSO_DISABLE_OVERRIDE when set to a falsy value", async () => {
    findFirstMock.mockResolvedValue(FULL_ROW);
    process.env.SSO_DISABLE_OVERRIDE = "false";
    const result = await getSsoSettings();
    expect(result?.ssoEnabled).toBe(true);
  });
});

describe("getSsoSettings — the 'cannot be offered' log line", () => {
  const originalSecret = process.env.FORWARD_AUTH_SECRET;

  beforeEach(() => {
    findFirstMock.mockReset();
    mockLoggerError.mockClear();
    delete process.env.SSO_DISABLE_OVERRIDE;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.FORWARD_AUTH_SECRET;
    else process.env.FORWARD_AUTH_SECRET = originalSecret;
  });

  it("logs once per reason, again for a new reason, and re-arms once fixed", async () => {
    delete process.env.FORWARD_AUTH_SECRET;
    findFirstMock.mockResolvedValue({ ...FULL_ROW, ssoMode: "FORWARD_AUTH" });
    await getSsoSettings();
    await getSsoSettings();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerError.mock.calls[0][1])).toMatch(/FORWARD_AUTH_SECRET/);

    // Fixed: nothing more is logged, and the latch is released.
    process.env.FORWARD_AUTH_SECRET = "proxy-secret";
    await getSsoSettings();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);

    // A different reason later in the same process is logged too.
    findFirstMock.mockResolvedValue({ ...FULL_ROW, oidcIssuer: "http://idp.lan" });
    await getSsoSettings();
    await getSsoSettings();
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
    expect(String(mockLoggerError.mock.calls[1][1])).toMatch(/https/);
  });
});
