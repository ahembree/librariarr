import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindSettings, mockGetSso, mockOverride } = vi.hoisted(() => ({
  mockFindSettings: vi.fn(),
  mockGetSso: vi.fn(),
  mockOverride: vi.fn(() => false),
}));

vi.mock("@/lib/db", () => ({
  prisma: { appSettings: { findFirst: mockFindSettings } },
}));

vi.mock("@/lib/sso/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sso/config")>()),
  getSsoSettings: mockGetSso,
  isSsoOverrideActive: mockOverride,
}));

import {
  isPasswordSignInEnabled,
  passwordSignInEnabled,
  turnsPasswordSignInOn,
} from "@/lib/auth/password-sign-in";
import type { SsoSettings } from "@/lib/sso/config";

const sso = (overrides: Partial<SsoSettings> = {}): SsoSettings => ({
  ssoEnabled: true,
  ssoMode: "OIDC",
  oidcIssuer: "https://idp.example.com",
  oidcClientId: "client",
  oidcClientSecret: null,
  oidcScopes: "openid",
  oidcUsernameClaim: "preferred_username",
  forwardAuthUserHeader: "Remote-User",
  forwardAuthEmailHeader: "Remote-Email",
  forwardAuthNameHeader: "Remote-Name",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockOverride.mockReturnValue(false);
});

describe("passwordSignInEnabled", () => {
  it("is on with local login on and no usable SSO", () => {
    expect(passwordSignInEnabled({ localAuthEnabled: true, sso: null })).toBe(true);
    expect(passwordSignInEnabled({ localAuthEnabled: true, sso: sso({ ssoEnabled: false }) })).toBe(true);
    // Enabled but not configured is not usable, as at login.
    expect(passwordSignInEnabled({ localAuthEnabled: true, sso: sso({ oidcIssuer: null }) })).toBe(true);
  });

  it("is off with local login off or unset, or SSO replacing the local form", () => {
    expect(passwordSignInEnabled({ localAuthEnabled: false, sso: null })).toBe(false);
    expect(passwordSignInEnabled({ localAuthEnabled: undefined, sso: null })).toBe(false);
    expect(passwordSignInEnabled({ localAuthEnabled: null, sso: null })).toBe(false);
    expect(passwordSignInEnabled({ localAuthEnabled: true, sso: sso() })).toBe(false);
    expect(
      passwordSignInEnabled({ localAuthEnabled: true, sso: sso({ ssoMode: "FORWARD_AUTH" }) }),
    ).toBe(false);
  });

  it("is on under SSO_DISABLE_OVERRIDE, the recovery path, as at login", () => {
    mockOverride.mockReturnValue(true);
    expect(passwordSignInEnabled({ localAuthEnabled: false, sso: sso() })).toBe(true);
  });
});

describe("isPasswordSignInEnabled", () => {
  it("reads the stored settings", async () => {
    mockFindSettings.mockResolvedValue({ localAuthEnabled: true });
    mockGetSso.mockResolvedValue(null);
    expect(await isPasswordSignInEnabled()).toBe(true);

    mockGetSso.mockResolvedValue(sso());
    expect(await isPasswordSignInEnabled()).toBe(false);

    // No settings row at all: local login is off.
    mockFindSettings.mockResolvedValue(null);
    mockGetSso.mockResolvedValue(null);
    expect(await isPasswordSignInEnabled()).toBe(false);
  });
});

describe("turnsPasswordSignInOn", () => {
  const off = { localAuthEnabled: false, sso: null };
  const on = { localAuthEnabled: true, sso: null };
  const hiddenBySso = { localAuthEnabled: true, sso: sso() };

  it("is true only for off → on with a password to give power back to", () => {
    expect(turnsPasswordSignInOn(off, on, true)).toBe(true);
    // Turning SSO off with local login on.
    expect(turnsPasswordSignInOn(hiddenBySso, on, true)).toBe(true);
    expect(turnsPasswordSignInOn(off, on, false)).toBe(false);
    expect(turnsPasswordSignInOn(on, on, true)).toBe(false);
    expect(turnsPasswordSignInOn(on, off, true)).toBe(false);
    // Local login on while SSO still replaces it: the password stays off.
    expect(turnsPasswordSignInOn(off, hiddenBySso, true)).toBe(false);
  });
});
