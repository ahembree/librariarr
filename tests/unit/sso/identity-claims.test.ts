import { describe, it, expect } from "vitest";
import { sanitizeUsername, sanitizeEmail } from "@/lib/sso/identity-claims";

describe("sanitizeUsername", () => {
  it("returns trimmed value for normal strings", () => {
    expect(sanitizeUsername("alice")).toBe("alice");
    expect(sanitizeUsername("  alice  ")).toBe("alice");
  });

  it("returns undefined for non-strings (arrays, numbers, null, undefined)", () => {
    expect(sanitizeUsername(undefined)).toBeUndefined();
    expect(sanitizeUsername(null)).toBeUndefined();
    expect(sanitizeUsername(42)).toBeUndefined();
    expect(sanitizeUsername(["alice"])).toBeUndefined();
    expect(sanitizeUsername({})).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only", () => {
    expect(sanitizeUsername("")).toBeUndefined();
    expect(sanitizeUsername("   ")).toBeUndefined();
  });

  it("strips control characters and NUL bytes", () => {
    // Log-injection vector — proxy emits "alice\n[FAKE LOG ENTRY]".
    expect(sanitizeUsername("alice\nbob")).toBe("alicebob");
    expect(sanitizeUsername("alice\x00bob")).toBe("alicebob");
    expect(sanitizeUsername("alice\rinjected")).toBe("aliceinjected");
    // DEL (0x7f).
    expect(sanitizeUsername("alice\x7fbob")).toBe("alicebob");
  });

  it("rejects values longer than the cap (defense against a hostile IdP)", () => {
    expect(sanitizeUsername("a".repeat(256))).toBe("a".repeat(256));
    expect(sanitizeUsername("a".repeat(257))).toBeUndefined();
    // A multi-MB value would be silently rejected, not truncated.
    expect(sanitizeUsername("x".repeat(10_000_000))).toBeUndefined();
  });

  it("returns undefined when the value becomes empty after stripping controls", () => {
    expect(sanitizeUsername("\n\r\x00")).toBeUndefined();
  });
});

describe("sanitizeEmail", () => {
  it("accepts simple addresses", () => {
    expect(sanitizeEmail("a@b.co")).toBe("a@b.co");
    expect(sanitizeEmail("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("rejects values without an @", () => {
    expect(sanitizeEmail("not-an-email")).toBeUndefined();
    expect(sanitizeEmail("alice")).toBeUndefined();
  });

  it("rejects values with multiple @s", () => {
    expect(sanitizeEmail("a@b@c.com")).toBeUndefined();
  });

  it("rejects empty local-part or domain-part", () => {
    expect(sanitizeEmail("@example.com")).toBeUndefined();
    expect(sanitizeEmail("alice@")).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(sanitizeEmail(undefined)).toBeUndefined();
    expect(sanitizeEmail(null)).toBeUndefined();
    expect(sanitizeEmail(42)).toBeUndefined();
  });

  it("strips control characters before validation", () => {
    // CRLF in the local part would otherwise be stored verbatim and
    // could be replayed as an SMTP header injection by something
    // downstream that consumes user.email naively.
    expect(sanitizeEmail("alice\n@example.com")).toBe("alice@example.com");
    expect(sanitizeEmail("a\x00b@example.com")).toBe("ab@example.com");
  });

  it("rejects values longer than the cap", () => {
    const longLocal = "a".repeat(248);
    expect(sanitizeEmail(`${longLocal}@x.co`)).toBe(`${longLocal}@x.co`);
    expect(sanitizeEmail(`${"a".repeat(255)}@x.co`)).toBeUndefined();
  });
});
