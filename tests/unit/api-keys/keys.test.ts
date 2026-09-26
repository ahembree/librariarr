import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
} from "@/lib/api-keys/keys";

describe("generateApiKey", () => {
  it("produces lbr_ + 43 base62 characters", () => {
    const { key } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 43);
    expect(key).toMatch(API_KEY_PATTERN);
    expect(isWellFormedApiKey(key)).toBe(true);
  });

  it("stores only a SHA-256 of the key, and a prefix too short to use", () => {
    const { key, keyHash, prefix } = generateApiKey();
    expect(keyHash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(keyHash).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(prefix).toBe(key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH));
    expect(prefix).toHaveLength(10);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => generateApiKey().key));
    expect(keys.size).toBe(2000);
  });

  it("draws from the whole base62 alphabet (no alphabet bias bug)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of generateApiKey().key.slice(API_KEY_PREFIX.length)) seen.add(ch);
    }
    // 21,500 draws over 62 symbols: every symbol appears unless the encoder
    // is broken (e.g. an off-by-one that can never emit the last character).
    expect(seen.size).toBe(62);
  });
});

describe("hashApiKey", () => {
  it("is deterministic and distinguishes keys", () => {
    const a = generateApiKey().key;
    const b = generateApiKey().key;
    expect(hashApiKey(a)).toBe(hashApiKey(a));
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
    expect(hashApiKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isWellFormedApiKey", () => {
  const valid = generateApiKey().key;

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
