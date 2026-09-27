import { describe, it, expect } from "vitest";
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  apiKeyLookupPrefix,
  containsApiKey,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  newApiKey,
  verifyApiKey,
} from "@/lib/api-keys/keys";

describe("newApiKey", () => {
  it("produces lbr_ + 43 base62 characters", () => {
    const key = newApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 43);
    expect(key).toMatch(API_KEY_PATTERN);
    expect(isWellFormedApiKey(key)).toBe(true);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => newApiKey()));
    expect(keys.size).toBe(2000);
  });

  it("draws from the whole base62 alphabet (no alphabet bias bug)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of newApiKey().slice(API_KEY_PREFIX.length)) seen.add(ch);
    }
    // 21,500 draws over 62 symbols: every symbol appears unless the encoder
    // is broken (e.g. an off-by-one that can never emit the last character).
    expect(seen.size).toBe(62);
  });
});

describe("generateApiKey", () => {
  it("stores a salted scrypt hash that verifies the key, and a prefix too short to use", async () => {
    const { key, keyHash, prefix } = await generateApiKey();
    expect(keyHash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(keyHash).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(await verifyApiKey(key, keyHash)).toBe(true);
    expect(prefix).toBe(key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH));
    expect(prefix).toBe(apiKeyLookupPrefix(key));
    expect(prefix).toHaveLength(10);
  });
});

describe("hashApiKey / verifyApiKey", () => {
  it("salts every hash, so the same key never hashes the same way twice", async () => {
    const key = newApiKey();
    const [a, b] = await Promise.all([hashApiKey(key), hashApiKey(key)]);
    expect(a).not.toBe(b);
    expect(await verifyApiKey(key, a)).toBe(true);
    expect(await verifyApiKey(key, b)).toBe(true);
  });

  it("verifies nothing but the key it was made from", async () => {
    const key = newApiKey();
    const stored = await hashApiKey(key);
    expect(await verifyApiKey(newApiKey(), stored)).toBe(false);
    // Same prefix, different secret.
    expect(await verifyApiKey(key.slice(0, 10) + newApiKey().slice(10), stored)).toBe(false);
    expect(await verifyApiKey(key.slice(0, -1), stored)).toBe(false);
  });

  it("verifies a hash made at another recorded cost", async () => {
    // The parameters travel with the hash, so the cost can be raised later
    // without invalidating keys hashed before.
    const key = newApiKey();
    const stored = await hashApiKey(key);
    const [, , r, p, salt] = stored.split("$");
    const { scryptSync } = await import("node:crypto");
    const cheaper = ["scrypt", 1024, r, p, salt, scryptSync(key, Buffer.from(salt, "base64url"), 32, { N: 1024, r: 8, p: 1 }).toString("base64url")].join("$");
    expect(await verifyApiKey(key, cheaper)).toBe(true);
  });

  it.each([
    ["an unsalted SHA-256 digest", "a".repeat(64)],
    ["another scheme", "bcrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA"],
    ["too few fields", "scrypt$16384$8$1$c2FsdA"],
    ["a cost that is not a power of two", "scrypt$1000$8$1$c2FsdHNhbHRzYWx0c2FsdA$" + "A".repeat(43)],
    ["a cost above 2^17", "scrypt$262144$8$1$c2FsdHNhbHRzYWx0c2FsdA$" + "A".repeat(43)],
    ["a block size above 8", "scrypt$16384$64$1$c2FsdHNhbHRzYWx0c2FsdA$" + "A".repeat(43)],
    ["a non-numeric cost", "scrypt$abc$8$1$c2FsdHNhbHRzYWx0c2FsdA$" + "A".repeat(43)],
    ["a short salt", "scrypt$16384$8$1$c2FsdA$" + "A".repeat(43)],
    ["a truncated hash", "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$AAAA"],
    ["an empty string", ""],
  ])("refuses %s as a stored hash, without throwing", async (_label, stored) => {
    await expect(verifyApiKey(newApiKey(), stored)).resolves.toBe(false);
  });
});

describe("isWellFormedApiKey", () => {
  const valid = newApiKey();

  it.each([
    ["wrong prefix", "lbx_" + valid.slice(4)],
    ["missing prefix", valid.slice(4)],
    ["too short", valid.slice(0, -1)],
    ["too long", valid + "a"],
    ["base64url character", valid.slice(0, -1) + "-"],
    ["underscore in secret", valid.slice(0, -1) + "_"],
    ["surrounding whitespace", ` ${valid}`],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(isWellFormedApiKey(value)).toBe(false);
  });
});

describe("containsApiKey", () => {
  const key = newApiKey();

  it("finds a key anywhere in a string", () => {
    expect(containsApiKey(key)).toBe(true);
    expect(containsApiKey(`/api/v1/media/${key}`)).toBe(true);
    expect(containsApiKey(`token=${key}&x=1`)).toBe(true);
    expect(containsApiKey(`_${key}`)).toBe(true);
  });

  it("ignores strings that only resemble one", () => {
    expect(containsApiKey("lbr_")).toBe(false);
    expect(containsApiKey(key.slice(0, -1))).toBe(false);
    expect(containsApiKey(`${key}Z`)).toBe(false);
    expect(containsApiKey(`a${key}`)).toBe(false);
  });
});
