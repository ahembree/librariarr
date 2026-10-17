import { describe, it, expect, vi, afterEach } from "vitest";
import { cn, generateId, getLetterForTitle } from "@/lib/utils";

describe("cn", () => {
  it("merges multiple class strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("ignores falsy values (false, null, undefined, empty string)", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("supports conditional object syntax", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("supports array inputs", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("resolves conflicting tailwind utility classes (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("resolves tailwind text color conflicts", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("keeps non-conflicting tailwind classes", () => {
    expect(cn("px-2 py-1", "text-sm")).toBe("px-2 py-1 text-sm");
  });

  it("returns empty string when given no/empty inputs", () => {
    expect(cn()).toBe("");
    expect(cn(false, null, undefined)).toBe("");
  });
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a v4 UUID from getRandomValues where randomUUID is unavailable", () => {
    // Older browsers, and any page served over plain HTTP: randomUUID needs a
    // secure context, getRandomValues does not.
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) });
    expect(generateId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    expect(generateId()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("returns unique values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  it("produces a UUID-shaped value in a crypto-enabled environment", () => {
    // Node test environment has the Web Crypto API, so output should be a v4-ish UUID.
    expect(generateId()).toMatch(UUID_V4);
  });
});

describe("getLetterForTitle", () => {
  it("returns the uppercase first letter for alphabetic titles", () => {
    expect(getLetterForTitle("apple")).toBe("A");
    expect(getLetterForTitle("Zebra")).toBe("Z");
  });

  it("uppercases a lowercase first letter", () => {
    expect(getLetterForTitle("matrix")).toBe("M");
  });

  it("trims leading whitespace before reading the first character", () => {
    expect(getLetterForTitle("   hello")).toBe("H");
  });

  it("returns '#' for titles starting with a digit", () => {
    expect(getLetterForTitle("300")).toBe("#");
  });

  it("returns '#' for titles starting with a symbol", () => {
    expect(getLetterForTitle("@home")).toBe("#");
    expect(getLetterForTitle("!bang")).toBe("#");
  });

  it("returns '#' for an empty string", () => {
    expect(getLetterForTitle("")).toBe("#");
  });

  it("returns '#' for a whitespace-only string", () => {
    expect(getLetterForTitle("   ")).toBe("#");
  });

  it("returns '#' for non-ASCII alphabetic first characters (outside A-Z)", () => {
    expect(getLetterForTitle("Éclair")).toBe("#");
  });

  it("handles boundary letters A and Z", () => {
    expect(getLetterForTitle("A")).toBe("A");
    expect(getLetterForTitle("z")).toBe("Z");
  });
});
