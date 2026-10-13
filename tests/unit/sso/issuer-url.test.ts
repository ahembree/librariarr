import { afterEach, describe, expect, it } from "vitest";
import { insecureHttpAllowed, isLoopbackHost, oidcIssuerProblem } from "@/lib/sso/issuer-url";

const original = process.env.OIDC_ALLOW_INSECURE_HTTP;

afterEach(() => {
  if (original === undefined) delete process.env.OIDC_ALLOW_INSECURE_HTTP;
  else process.env.OIDC_ALLOW_INSECURE_HTTP = original;
});

describe("isLoopbackHost", () => {
  it("recognises localhost, its subdomains, 127/8 and ::1", () => {
    for (const host of ["localhost", "LOCALHOST", "idp.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("is false for everything else, including private networks", () => {
    for (const host of ["idp.lan", "10.0.0.5", "192.168.1.10", "127.0.0.1.evil.example", "localhost.evil.example", "128.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("oidcIssuerProblem", () => {
  it("accepts https anywhere", () => {
    delete process.env.OIDC_ALLOW_INSECURE_HTTP;
    expect(oidcIssuerProblem("https://idp.example.com")).toBeNull();
    expect(oidcIssuerProblem("  https://idp.example.com/realms/x/  ")).toBeNull();
    expect(oidcIssuerProblem("https://10.0.0.5:8443")).toBeNull();
  });

  // The OIDC client verifies no ID token signature: TLS is what authenticates
  // the issuer, so plain HTTP to a network host is an admin login for whoever
  // is on the path.
  it("refuses http off loopback, naming the rule and the override", () => {
    delete process.env.OIDC_ALLOW_INSECURE_HTTP;
    for (const issuer of ["http://idp.lan", "http://10.0.0.5:9000", "http://localhost.evil.example"]) {
      const problem = oidcIssuerProblem(issuer);
      expect(problem).toMatch(/https/);
      expect(problem).toMatch(/OIDC_ALLOW_INSECURE_HTTP/);
    }
  });

  it("accepts http on loopback", () => {
    delete process.env.OIDC_ALLOW_INSECURE_HTTP;
    for (const issuer of ["http://localhost:9000", "http://127.0.0.1:9000/realm", "http://[::1]:9000", "http://idp.localhost"]) {
      expect(oidcIssuerProblem(issuer)).toBeNull();
    }
  });

  it("refuses other schemes and non-URLs", () => {
    for (const value of ["ftp://idp.example.com", "idp.example.com", "", "javascript:alert(1)", "https://"]) {
      expect(oidcIssuerProblem(value)).toMatch(/https/);
    }
  });

  it("accepts http anywhere under OIDC_ALLOW_INSECURE_HTTP, for the truthy spellings only", () => {
    for (const value of ["true", "1", "yes", " TRUE "]) {
      process.env.OIDC_ALLOW_INSECURE_HTTP = value;
      expect(insecureHttpAllowed()).toBe(true);
      expect(oidcIssuerProblem("http://idp.lan")).toBeNull();
    }
    for (const value of ["false", "0", "no", ""]) {
      process.env.OIDC_ALLOW_INSECURE_HTTP = value;
      expect(insecureHttpAllowed()).toBe(false);
      expect(oidcIssuerProblem("http://idp.lan")).not.toBeNull();
    }
  });
});
