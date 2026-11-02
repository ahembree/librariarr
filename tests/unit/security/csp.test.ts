import { describe, it, expect } from "vitest";
import { buildCsp, generateNonce } from "@/lib/security/csp";

describe("buildCsp", () => {
  it("allows page scripts by nonce, with strict-dynamic, and never eval in production", () => {
    const csp = buildCsp({ nonce: "abc" });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      expect(csp).toContain(d);
    }
  });

  it("is the nonce-less policy without a nonce", () => {
    expect(buildCsp()).toContain("script-src 'self' 'unsafe-inline';");
    expect(buildCsp()).not.toContain("nonce-");
  });

  it("adds eval only in development", () => {
    expect(buildCsp({ nonce: "abc", dev: true })).toContain("'strict-dynamic' 'unsafe-inline' 'unsafe-eval'");
  });
});

describe("generateNonce", () => {
  it("is 16 random bytes in base64, different every call", () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(generateNonce()).not.toBe(a);
  });
});
