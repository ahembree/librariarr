import { describe, expect, it } from "vitest";
import {
  ssoConfigSchema,
  ssoLinkSchema,
  ssoTestSchema,
} from "@/lib/validation";

describe("ssoConfigSchema", () => {
  it("accepts the empty object (partial updates allowed)", () => {
    expect(ssoConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full OIDC payload", () => {
    const result = ssoConfigSchema.safeParse({
      ssoEnabled: true,
      ssoMode: "OIDC",
      oidcIssuer: "https://idp.example.com",
      oidcClientId: "client-1",
      oidcClientSecret: "s3cret",
      oidcScopes: "openid profile email",
      oidcUsernameClaim: "preferred_username",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full FORWARD_AUTH payload", () => {
    const result = ssoConfigSchema.safeParse({
      ssoEnabled: true,
      ssoMode: "FORWARD_AUTH",
      forwardAuthUserHeader: "Remote-User",
      forwardAuthEmailHeader: "Remote-Email",
      forwardAuthNameHeader: "Remote-Name",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown ssoMode values", () => {
    const result = ssoConfigSchema.safeParse({ ssoMode: "SAML" });
    expect(result.success).toBe(false);
  });

  it("rejects an issuer URL without a scheme", () => {
    const result = ssoConfigSchema.safeParse({
      oidcIssuer: "idp.example.com/auth",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty-string issuer (used to clear the field)", () => {
    expect(ssoConfigSchema.safeParse({ oidcIssuer: "" }).success).toBe(true);
  });

  it("accepts null for nullable credential fields", () => {
    const result = ssoConfigSchema.safeParse({
      oidcIssuer: null,
      oidcClientId: null,
      oidcClientSecret: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty scopes string", () => {
    const result = ssoConfigSchema.safeParse({ oidcScopes: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty username claim", () => {
    const result = ssoConfigSchema.safeParse({ oidcUsernameClaim: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty forward-auth header names", () => {
    expect(
      ssoConfigSchema.safeParse({ forwardAuthUserHeader: "" }).success
    ).toBe(false);
    expect(
      ssoConfigSchema.safeParse({ forwardAuthEmailHeader: "" }).success
    ).toBe(false);
    expect(
      ssoConfigSchema.safeParse({ forwardAuthNameHeader: "" }).success
    ).toBe(false);
  });
});

describe("ssoTestSchema", () => {
  it("accepts a valid issuer URL", () => {
    expect(
      ssoTestSchema.safeParse({ oidcIssuer: "https://idp.example.com" })
        .success
    ).toBe(true);
  });

  it("accepts http for self-hosted environments", () => {
    expect(
      ssoTestSchema.safeParse({ oidcIssuer: "http://localhost:9000" }).success
    ).toBe(true);
  });

  it("rejects when the issuer lacks a scheme", () => {
    expect(
      ssoTestSchema.safeParse({ oidcIssuer: "idp.example.com" }).success
    ).toBe(false);
  });

  it("rejects when the issuer is missing", () => {
    expect(ssoTestSchema.safeParse({}).success).toBe(false);
  });
});

describe("ssoLinkSchema", () => {
  it("accepts a subject-only payload", () => {
    const result = ssoLinkSchema.safeParse({ ssoSubject: "user-1" });
    expect(result.success).toBe(true);
  });

  it("accepts subject + provider", () => {
    const result = ssoLinkSchema.safeParse({
      ssoSubject: "user-1",
      ssoProvider: "Authentik",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty subject", () => {
    const result = ssoLinkSchema.safeParse({ ssoSubject: "" });
    expect(result.success).toBe(false);
  });

  it("rejects when subject is missing", () => {
    const result = ssoLinkSchema.safeParse({ ssoProvider: "x" });
    expect(result.success).toBe(false);
  });
});
